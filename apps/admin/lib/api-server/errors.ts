import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '@aptamind/contracts';

const STATUS: Record<string, number> = {
  not_found: 404,
  conflict: 409,
  validation_failed: 400,
  invalid_state: 409,
  unsafe_url: 400,
  limit_exceeded: 413,
  unavailable: 503,
  internal: 500,
};

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ZodError) {
    return reply.status(400).send({
      error: { code: 'validation_failed', message: 'Invalid request', issues: err.issues.slice(0, 20) },
    });
  }
  const code = (err as { code?: unknown }).code;
  if (err instanceof AppError || (typeof code === 'string' && code in STATUS)) {
    const c = String(code);
    return reply
      .status(STATUS[c] ?? 500)
      .send({ error: { code: c, message: err.message, details: (err as AppError).details } });
  }
  const statusCode = (err as FastifyError).statusCode;
  if (statusCode && statusCode < 500)
    return reply.status(statusCode).send({ error: { code: 'bad_request', message: err.message } });
  req.log.error({ err }, 'unhandled API error');
  return reply
    .status(500)
    .send({ error: { code: 'internal', message: 'Internal error', requestId: req.ctx?.requestId } });
}
