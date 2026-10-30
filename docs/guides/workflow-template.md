# How to add a workflow template

Templates are code-authored `WorkflowSpec`s (e.g. `packages/market/src/workflows/index.ts`),
registered at worker/API startup (`runtime.registerWorkflows`). Registration is idempotent;
changing a spec creates a new immutable version, and past runs keep their version.

```ts
export const myRefresh: WorkflowSpec = {
  key: 'market.example.refresh',
  title: 'Example refresh',
  description: 'What it does and why.',
  nodes: [
    {
      id: 'trigger',
      capability: { type: 'core.schedule_trigger', version: 1 },
      input: { payload: ref('run.input'), trigger: ref('trigger') },
    },
    {
      id: 'fetch',
      capability: { type: 'market.fetch_job_board', version: 2 },
      input: { sourceId: ref('nodes.trigger.output.payload.sourceId') },
      retry: { maxAttempts: 4, backoffMs: 5000 },
    },
    {
      id: 'ingest',
      capability: { type: 'core.for_each', version: 1 },
      config: {
        body: {
          capability: { type: 'market.ingest_job_observation', version: 1 },
          input: { sourceId: ref('run.input.sourceId'), item: ref('item') },
        },
        concurrency: 4,
        batchSize: 25,
      },
      input: { items: ref('nodes.fetch.output.records') },
    },
  ],
  edges: [
    { from: 'trigger', to: 'fetch' },
    { from: 'fetch', to: 'ingest' },
  ],
  labels: { domain: 'market' },
  defaultSchedule: { intervalMinutes: 360, enabled: false, input: {} },
};
```

Rules:

- Compose capabilities; do not encode business policy in the template.
- Reference only upstream nodes (`nodes.<id>.output…`); validation rejects anything else,
  unknown capabilities, invalid config and cycles — before any run.
- Branch with `core.if`/`core.switch` + `edges[].when.branch`.
- Fan out with `core.for_each` (always bounded: `concurrency`, `batchSize`, `maxFailureRatio`).
- Reuse workflows with `core.execute_subworkflow` or a `for_each` body `workflow`.
- Add the spec to the exported list (e.g. `marketWorkflows`). To run it on a schedule, either
  set `defaultSchedule` or attach it to a source (`acquisition.workflowKey` + `schedule`).
