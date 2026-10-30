import { describe, expect, it } from 'vitest';
import { ProfessionalError } from '../api/errors';
import { SOURCE_KIND_POLICIES } from './policies';
import {
  checkUpload,
  MAX_PDF_OBJECTS_SCANNED,
  matchesSignature,
  normalizeUploadMimeType,
  visiblePdfPages,
} from './upload';

const enc = (s: string) => new TextEncoder().encode(s);
const pageObjects = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => `${from + i} 0 obj << /Type /Page /Parent 1 0 R >> endobj\n`).join('');
const pdf = (pages: number) =>
  enc(`%PDF-1.4\n1 0 obj << /Type /Pages /Count ${pages} >> endobj\n${pageObjects(2, pages)}%%EOF`);
const limits = { maxBytes: 1000, maxPages: 3 };
const cv = SOURCE_KIND_POLICIES.cv.uploadMimeTypes;

const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (err) {
    return err instanceof ProfessionalError
      ? `${err.code}:${Object.values(err.details ?? {}).join(',')}`
      : 'unexpected';
  }
};

describe('upload checks (R-3)', () => {
  it('accepts allowed types whose bytes match, and hashes the content', () => {
    const ok = checkUpload(enc('Experience\nDesigner'), 'text/plain; charset=UTF-8', cv, limits);
    expect(ok).toMatchObject({ mimeType: 'text/plain', size: 19 });
    expect(ok.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(checkUpload(pdf(3), 'application/pdf', cv, limits).mimeType).toBe('application/pdf');
  });

  it('rejects by size first, then type, signature, encoding and pages', () => {
    expect(code(() => checkUpload(new Uint8Array(1001), 'application/pdf', cv, limits))).toBe(
      'upload_too_large:bytes',
    );
    expect(code(() => checkUpload(new Uint8Array(0), 'text/plain', cv, limits))).toBe(
      'validation_failed:body',
    );
    expect(code(() => checkUpload(enc('x'), undefined, cv, limits))).toBe(
      'unsupported_media_type:media_type',
    );
    expect(code(() => checkUpload(enc('x'), 'application/json', cv, limits))).toBe(
      'unsupported_media_type:media_type',
    );
    expect(code(() => checkUpload(enc('x'), 'image/png', cv, limits))).toBe(
      'unsupported_media_type:media_type',
    );
    expect(code(() => checkUpload(enc('<html>'), 'application/pdf', cv, limits))).toBe(
      'unsupported_media_type:signature',
    );
    expect(code(() => checkUpload(new Uint8Array([0x66, 0x00, 0x67]), 'text/plain', cv, limits))).toBe(
      'unsupported_media_type:encoding',
    );
    expect(code(() => checkUpload(new Uint8Array([0xc3, 0x28]), 'text/markdown', cv, limits))).toBe(
      'unsupported_media_type:encoding',
    );
    expect(code(() => checkUpload(enc('x'), 'text/plain; charset=latin1', cv, limits))).toBe(
      'unsupported_media_type:charset',
    );
    expect(code(() => checkUpload(pdf(4), 'application/pdf', cv, limits))).toBe('upload_too_large:pages');
  });

  it('checks signatures per type', () => {
    expect(matchesSignature('application/zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toBe(true);
    expect(matchesSignature('application/zip', enc('PK'))).toBe(false);
    expect(
      matchesSignature('image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe(true);
    expect(matchesSignature('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(matchesSignature('text/csv', enc('a,b\n1,2'))).toBe(true);
  });

  it('normalizes the declared media type and counts only visible page objects', () => {
    expect(normalizeUploadMimeType('Text/Markdown; charset="utf-8"')).toBe('text/markdown');
    expect(visiblePdfPages(pdf(2))).toBe(2);
    expect(
      visiblePdfPages(
        enc(
          '%PDF-1.7\n1 0 obj <</Type/Pages>> endobj 2 0 obj <</Type/Page>> endobj 3 0 obj <</Type /PageLabel>> endobj',
        ),
      ),
    ).toBe(1);
  });

  it('counts distinct page objects, so incremental saves do not double-count', () => {
    // An incremental update re-emits pages 2 and 3 after the first %%EOF.
    const incremental = enc(
      `%PDF-1.4\n${pageObjects(2, 3)}%%EOF\n${pageObjects(2, 2)}%%EOF\n${pageObjects(2, 3)}%%EOF`,
    );
    expect(visiblePdfPages(incremental)).toBe(3);
    expect(code(() => checkUpload(incremental, 'application/pdf', cv, limits))).toBe('ok');
    // Page dictionaries outside indirect objects are not counted (undercounting is accepted).
    expect(visiblePdfPages(enc('%PDF-1.4 << /Type /Page >> << /Type /Page >>'))).toBe(0);
  });

  it('only upload kinds accept media types; LinkedIn exports are zip or csv', () => {
    for (const k of ['manual_input', 'questionnaire', 'github', 'personal_website'] as const)
      expect(SOURCE_KIND_POLICIES[k].uploadMimeTypes).toEqual([]);
    expect(SOURCE_KIND_POLICIES.linkedin_export.uploadMimeTypes).toEqual(['application/zip', 'text/csv']);
  });
});

describe('PDF page estimate is linear (no ReDoS on the API event loop)', () => {
  const MiB = 1024 * 1024;
  const fill = (unit: string, prefix = '%PDF-1.7\n', suffix = '') =>
    enc(prefix + unit.repeat(Math.ceil((10 * MiB) / unit.length)) + suffix);
  const cases: Array<[string, Uint8Array]> = [
    ['10 MiB of digits', fill('1')],
    ['object headers without endobj', fill('1 0 obj ')],
    ['page objects beyond the scan cap', fill('1 0 obj /Type /Page endobj\n')],
    ['one header, then whitespace', fill(' ', '%PDF-1.7\n1 ')],
    ['one object full of /Type', fill('/Type ', '%PDF-1.7\n1 0 obj ', 'endobj')],
    ['digits and whitespace alternating', fill('1 1 ')],
  ];
  it.each(cases)('%s: completes in < 500 ms', (_label, bytes) => {
    const started = performance.now();
    visiblePdfPages(bytes);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('stops after the object cap (the count is then a lower bound)', () => {
    expect(MAX_PDF_OBJECTS_SCANNED).toBe(100_000);
    const many = enc(`%PDF-1.7\n${pageObjects(2, 100_010)}`);
    expect(visiblePdfPages(many)).toBe(100_000);
  });
});
