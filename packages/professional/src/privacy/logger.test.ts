import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@aptamind/observability';
import { professionalLogger, safeError } from './logger';

const CANARY = 'CANARY-7f3a91';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: createLogger({ service: 'test', level: 'trace', destination: stream }) };
}

/** A MongoServerError-like failure: its message, errInfo and keyValue quote the document. */
function mongoError() {
  const err = new Error(
    `E11000 duplicate key error dup key: { externalRefKey: "url:https://${CANARY}.example/" }`,
  );
  return Object.assign(err, {
    name: 'MongoServerError',
    code: 11000,
    codeName: 'DuplicateKey',
    keyValue: { externalRefKey: `url:https://${CANARY}.example/` },
    errInfo: { details: { schemaRulesNotSatisfied: [{ reason: `value ${CANARY}` }] } },
    errorResponse: { errmsg: CANARY },
  });
}

describe('Professional logging never carries values (R-32, A-NIT-5)', () => {
  it('safeError keeps only the class name and codes', () => {
    expect(safeError(mongoError())).toEqual({
      type: 'MongoServerError',
      code: 11000,
      codeName: 'DuplicateKey',
    });
    expect(safeError('boom')).toEqual({ type: 'string' });
    expect(JSON.stringify(safeError(mongoError()))).not.toContain(CANARY);
  });

  it('the child logger redacts value-bearing keys, including MongoDB error internals', () => {
    const { lines, logger } = capture();
    const log = professionalLogger(logger);
    log.error({ err: mongoError() }, 'write failed');
    log.info(
      {
        errInfo: { canary: CANARY },
        keyValue: { k: CANARY },
        source: { url: `https://${CANARY}.example`, reference: CANARY },
        observation: { quote: CANARY, payload: { text: CANARY }, value: CANARY },
        person: { name: CANARY, email: `${CANARY}@example.org`, phone: CANARY },
      },
      'values',
    );
    const out = lines.join('\n');
    expect(out).toContain('"domain":"professional"');
    expect(out).toContain('write failed');
    expect(out).not.toContain(CANARY);
  });
});
