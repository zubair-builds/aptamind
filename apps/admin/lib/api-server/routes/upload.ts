import type { FastifyRequest } from 'fastify';
import { type Readable, Transform } from 'node:stream';
import { AppError } from '@aptamind/contracts';
import type { MarketDomain } from '@aptamind/market';

/**
 * `preParsing` hook for a file upload to a source. Providers with an upload ceiling (company
 * directory, ATS board file: their configured `maxBytes`, at most 50 MB) are refused from the
 * declared length before the body is read, and a body without a length is cut off at the ceiling
 * while it streams: a 50 MB file never costs a 200 MB buffer.
 */
export function uploadPreParsing(market: MarketDomain, sourceIdOf: (req: FastifyRequest) => string) {
  return async (req: FastifyRequest, _reply: unknown, payload: Readable): Promise<Readable> => {
    const limit = await market.sources.uploadLimit(sourceIdOf(req));
    if (limit === null) return payload;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit)
      throw new AppError(
        'limit_exceeded',
        `Upload refused: the file is ${declared} bytes; this source accepts at most ${limit}`,
        { problems: [{ code: 'too_large' }] },
      );
    return capStream(payload, limit);
  };
}

/** The uploaded body as bytes (a view on the parsed buffer, not a copy) or text, and its media type. */
export function uploadedFile(req: FastifyRequest): { body: Uint8Array | string; contentType: string } {
  const contentType = String(req.headers['content-type'] ?? 'application/octet-stream').split(
    ';',
  )[0] as string;
  const body =
    typeof req.body === 'string'
      ? req.body
      : Buffer.isBuffer(req.body)
        ? new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength)
        : JSON.stringify(req.body);
  return { body, contentType };
}

/** The request body stream, failing with 413 once more than `limit` bytes arrived. */
function capStream(payload: Readable, limit: number): Readable {
  let seen = 0;
  const capped = new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      if (seen > limit)
        done(
          Object.assign(
            new AppError('limit_exceeded', `Upload refused: this source accepts at most ${limit} bytes`, {
              problems: [{ code: 'too_large' }],
            }),
            { statusCode: 413 },
          ),
        );
      else done(null, chunk);
    },
  });
  payload.on('error', (err) => capped.destroy(err));
  return payload.pipe(capped);
}
