import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

/**
 * OpenTelemetry-compatible tracing seam. Without a registered SDK/exporter the
 * OpenTelemetry API is a no-op, so this costs nothing until tracing is configured.
 */
const tracer = trace.getTracer('aptamind');

export async function withSpan<T>(name: string, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
      throw err;
    } finally {
      span.end();
    }
  });
}
