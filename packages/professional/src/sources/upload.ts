import { createHash } from 'node:crypto';
import { ProfessionalError } from '../api/errors';
import type { ProfessionalLimits } from '../context';
import { UPLOAD_MIME_TYPES, type UploadMimeType } from './policies';

/**
 * Pre-storage checks for an uploaded document (R-3): size, declared media type, byte signature
 * and page count. Nothing reaches the artifact store unless all pass. Errors carry the limit or
 * media type code only, never content.
 */

const TEXT_TYPES = new Set<UploadMimeType>(['text/plain', 'text/markdown', 'text/html', 'text/csv']);
const ZIP_TYPES = new Set<UploadMimeType>([
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export const tooLarge = (limit: 'bytes' | 'pages') =>
  new ProfessionalError('upload_too_large', 'Upload exceeds a limit', { limit });

const unsupported = (reason: 'media_type' | 'signature' | 'charset' | 'encoding') =>
  new ProfessionalError('unsupported_media_type', 'Unsupported media type', { reason });

/**
 * The declared media type, lower-cased and without parameters. Text types accept only a UTF-8
 * (or US-ASCII) charset parameter; any other parameter is ignored.
 */
export function normalizeUploadMimeType(contentType: string | undefined): UploadMimeType {
  if (!contentType) throw unsupported('media_type');
  const [type, ...params] = contentType.split(';').map((p) => p.trim().toLowerCase());
  if (!(UPLOAD_MIME_TYPES as readonly string[]).includes(type ?? '')) throw unsupported('media_type');
  const mime = type as UploadMimeType;
  for (const p of params) {
    const [k, v] = p.split('=').map((x) => x?.trim().replace(/^"|"$/g, ''));
    if (k === 'charset' && TEXT_TYPES.has(mime) && v !== 'utf-8' && v !== 'utf8' && v !== 'us-ascii')
      throw unsupported('charset');
  }
  return mime;
}

const startsWith = (bytes: Uint8Array, sig: readonly number[]) =>
  bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);

/** Whether the bytes carry the signature of the declared type (text: valid UTF-8, no NUL). */
export function matchesSignature(mime: UploadMimeType, bytes: Uint8Array): boolean {
  if (mime === 'application/pdf') return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  if (ZIP_TYPES.has(mime)) return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]); // PK\3\4
  if (mime === 'image/png') return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mime === 'image/jpeg') return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pre-storage PDF page estimate: the distinct object numbers of indirect objects
 * (`N G obj … endobj`) that are page objects (`/Type /Page`, not `/Pages`). Counting object
 * numbers, not occurrences, keeps incremental saves (which re-emit changed objects) from
 * double-counting. It undercounts pages hidden in compressed object streams — accepted: text
 * extraction (P2.1) enforces the limit on the parsed document.
 *
 * Linear in the input (it runs on the API event loop before storage, on untrusted bytes): object
 * headers are digit-bounded and found with a global regex resumed (`lastIndex`) at the previous
 * object's `endobj`, each
 * body is found with `indexOf('endobj')` and scanned once, and at most `MAX_PDF_OBJECTS_SCANNED`
 * objects are examined (beyond that the count is a lower bound).
 */
export const MAX_PDF_OBJECTS_SCANNED = 100_000;
const PDF_OBJECT_HEADER = /(?<!\d)(\d{1,10})[ \t\r\n\f\0]{1,8}\d{1,5}[ \t\r\n\f\0]{1,8}obj\b/g;
const PDF_PAGE_TYPE = /\/Type[ \t\r\n\f\0]{0,8}\/Page(?![A-Za-z])/;

export function visiblePdfPages(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const pages = new Set<string>();
  const header = new RegExp(PDF_OBJECT_HEADER.source, 'g');
  for (let scanned = 0; scanned < MAX_PDF_OBJECTS_SCANNED; scanned++) {
    const m = header.exec(text);
    if (!m) break;
    const end = text.indexOf('endobj', header.lastIndex);
    if (end === -1) break; // no further complete object
    if (PDF_PAGE_TYPE.test(text.slice(header.lastIndex, end))) pages.add(m[1]!);
    header.lastIndex = end + 6;
  }
  return pages.size;
}

export interface CheckedUpload {
  mimeType: UploadMimeType;
  /** SHA-256 of the bytes (hex): the snapshot's content address. */
  contentHash: string;
  size: number;
}

/**
 * Checks an upload for a source kind's allowed media types and the limits. Order: size (413),
 * declared type (415), signature/encoding (415), pages (413). Rejects before anything is stored.
 */
export function checkUpload(
  bytes: Uint8Array,
  contentType: string | undefined,
  allowed: readonly UploadMimeType[],
  limits: { maxBytes: ProfessionalLimits['maxUploadBytes']; maxPages: number },
): CheckedUpload {
  if (bytes.byteLength > limits.maxBytes) throw tooLarge('bytes');
  if (bytes.byteLength === 0)
    throw new ProfessionalError('validation_failed', 'Empty upload', { field: 'body' });
  const mimeType = normalizeUploadMimeType(contentType);
  if (!allowed.includes(mimeType)) throw unsupported('media_type');
  if (!matchesSignature(mimeType, bytes))
    throw unsupported(TEXT_TYPES.has(mimeType) ? 'encoding' : 'signature');
  if (mimeType === 'application/pdf' && visiblePdfPages(bytes) > limits.maxPages) throw tooLarge('pages');
  return {
    mimeType,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  };
}
