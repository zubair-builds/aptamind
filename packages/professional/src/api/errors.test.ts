import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProfessionalError, toHttpError, uploadTransportError } from './errors';

const CANARY = 'CANARY-51c0de';

describe('toHttpError', () => {
  it('reduces Zod issues to path, code and message — never the input', () => {
    const schema = z.strictObject({
      reference: z.string().regex(/^[a-z]+$/, { message: 'bad reference' }),
      n: z.number(),
    });
    const r = schema.safeParse({ reference: `${CANARY}@example.org`, n: CANARY, extra: CANARY });
    const res = toHttpError(r.error);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.issues?.map((i) => i.path.join('.'))).toEqual(
      expect.arrayContaining(['reference', 'n']),
    );
    expect(JSON.stringify(res)).not.toContain(CANARY);
    expect(res.unexpected).toBe(false);
  });

  it('never echoes unrecognized key names (they are request input)', () => {
    const r = z.strictObject({ a: z.string().optional() }).safeParse({ [CANARY]: 1, [`${CANARY}2`]: 2 });
    const res = toHttpError(r.error);
    expect(res.body.error.issues).toEqual([
      { path: [], code: 'unrecognized_keys', message: 'Unrecognized key' },
    ]);
    expect(JSON.stringify(res)).not.toContain(CANARY);
  });

  it('maps Fastify 413/415 to upload codes only through uploadTransportError', () => {
    const big = Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    const media = Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 });
    expect(uploadTransportError(big)?.body.error).toMatchObject({ code: 'upload_too_large' });
    expect(uploadTransportError(media)?.body.error).toMatchObject({ code: 'unsupported_media_type' });
    expect(uploadTransportError(new ProfessionalError('conflict', 'x'))).toBeUndefined();
    expect(toHttpError(big).body.error.code).toBe('bad_request');
  });

  it('maps Professional codes to statuses', () => {
    expect(
      toHttpError(new ProfessionalError('not_found', 'subject not found', { id: 'psub_1' })).status,
    ).toBe(404);
    expect(toHttpError(new ProfessionalError('idempotency_key_reused', 'x')).status).toBe(409);
    expect(toHttpError(new ProfessionalError('subject_archived', 'x')).status).toBe(409);
    expect(toHttpError(new ProfessionalError('stale_subject_revision', 'x')).status).toBe(409);
    expect(toHttpError(new ProfessionalError('linkedin_import_only', 'x')).status).toBe(400);
  });

  it('never quotes parser or document-validation messages', () => {
    const parse = Object.assign(new SyntaxError(`Unexpected token 'C', "${CANARY}" is not valid JSON`), {
      statusCode: 400,
    });
    const doc = Object.assign(new Error(`Document for x failed validation: reference: ${CANARY}`), {
      code: 'validation_failed',
    });
    for (const err of [parse, doc]) {
      const res = toHttpError(err);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res)).not.toContain(CANARY);
    }
  });

  it('unknown failures are a 500 with the request id and flagged for (safe) logging', () => {
    const res = toHttpError(Object.assign(new Error(CANARY), { code: 11000 }), 'req_1');
    expect(res).toMatchObject({
      status: 500,
      unexpected: true,
      body: { error: { code: 'internal', requestId: 'req_1' } },
    });
    expect(JSON.stringify(res)).not.toContain(CANARY);
  });
});
