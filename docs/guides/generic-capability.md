# How to create a generic capability

Generic capabilities live in `packages/workflow-nodes/src/nodes/` and must not reference any
domain (no companies/jobs). Example — a capability that counts records:

```ts
import { z } from 'zod';
import { defineCapability, recordsInputSchema } from '@aptamind/workflow-sdk';

export const countRecords = defineCapability({
  type: 'core.count_records', // namespaced lower_snake; immutable meaning per version
  version: 1, // bump the version for any behavioural change
  title: 'Count Records',
  description: 'Counts records in an inline array or record set.',
  category: 'transform',
  inputSchema: z.object({ records: recordsInputSchema }),
  outputSchema: z.object({ count: z.number().int() }),
  configSchema: z.object({}), // validated when a workflow is registered
  execution: { retryable: false, idempotency: 'optional', sideEffects: false },
  async execute(ctx, input) {
    let count = 0;
    for await (const _ of ctx.records.read(input.records)) count += 1;
    return { count };
  },
});
```

Checklist:

1. **Schemas**: inputs/outputs must be JSON-serialisable. Large data → write a record set
   (`ctx.records.write`) or an artifact (`ctx.artifacts.put`) and return the reference.
2. **Errors**: throw `RetryableError` for transient failures and `TerminalError` for permanent
   ones; unclassified errors follow `execution.retryable`.
3. **Idempotency**: if the capability has side effects, key them on `ctx.idempotencyKey`
   (stable across retries and per fan-out item) and declare `idempotency: 'required'`.
   Declare `'none'` only if re-running is unsafe (operator retry is then refused).
4. **Cancellation/timeouts**: pass `ctx.signal` to I/O; call `ctx.heartbeat()` in long loops.
5. **Network**: use `ctx.services.get(NET_CLIENT)` — never raw `fetch` (SSRF protection,
   scoping, limits). Browser work goes to the `browser` queue.
6. **Queues**: set `execution.queue` (`io`, `browser`, `ai`) for work that should scale separately.
7. Register it in `genericCapabilities` (`packages/workflow-nodes/src/index.ts`) and add unit tests.
   `GET /api/capabilities` will list it with JSON Schemas.
