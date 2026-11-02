import { describe, expect, it } from 'vitest';
import { AppError } from '@aptamind/contracts';
import {
  IMPORT_PROPOSAL_MAX_BYTES,
  PROPOSAL_REASON_MAX,
  assertProposalBodySize,
  boundProposalText,
  importProposalContext,
  importProposalDedupeKey,
  sourceProposalDedupeKey,
  sourceProposalInput,
  textRowCount,
} from './proposal.service';

describe('proposal helpers', () => {
  it('builds stable dedupe keys', () => {
    expect(sourceProposalDedupeKey('boards:acme')).toBe('proposal:source:boards:acme');
    expect(importProposalDedupeKey('a'.repeat(64), 'src_1')).toBe(`proposal:import:${'a'.repeat(64)}:src_1`);
  });

  it('bounds reason text and keeps a short string', () => {
    expect(boundProposalText('short')).toBe('short');
    expect(boundProposalText('x'.repeat(PROPOSAL_REASON_MAX + 40))).toHaveLength(PROPOSAL_REASON_MAX);
    expect(boundProposalText('abcdef', 4)).toBe('abcd');
  });

  it('allows the import size cap and refuses one byte over it', () => {
    expect(() => assertProposalBodySize(0)).not.toThrow();
    expect(() => assertProposalBodySize(IMPORT_PROPOSAL_MAX_BYTES)).not.toThrow();
    expect(IMPORT_PROPOSAL_MAX_BYTES).toBe(5 * 1024 * 1024);
    try {
      assertProposalBodySize(IMPORT_PROPOSAL_MAX_BYTES + 1);
      expect.fail('expected limit_exceeded');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('limit_exceeded');
    }
    expect(() => assertProposalBodySize(-1)).toThrow(AppError);
    expect(() => assertProposalBodySize(1.5)).toThrow(AppError);
  });

  it('counts non-empty lines for text, csv and json only', () => {
    const lines = new TextEncoder().encode('a\r\nb\n\n  \nc');
    expect(textRowCount(lines, 'text/csv')).toBe(3);
    expect(textRowCount(lines, 'application/json')).toBe(3);
    expect(textRowCount(new Uint8Array(), 'text/plain')).toBe(0);
    expect(textRowCount(lines, 'application/octet-stream')).toBeUndefined();
  });

  it('reads a source proposal input and an import proposal context', () => {
    expect(sourceProposalInput({ input: { key: 'acme', name: 'Acme' } })).toEqual({
      key: 'acme',
      name: 'Acme',
    });
    expect(() => sourceProposalInput({})).toThrow(AppError);
    const ctx = importProposalContext({
      type: 'snapshot',
      sourceId: 'src_1',
      contentType: 'text/csv',
      artifactId: 'art_1',
      sha256: 'ab'.repeat(32),
      size: 3,
      rowCount: 1,
    });
    expect(ctx.type).toBe('snapshot');
    expect(ctx.rowCount).toBe(1);
    expect(() => importProposalContext({ type: 'snapshot', sourceId: 'src_1' })).toThrow(AppError);
  });
});
