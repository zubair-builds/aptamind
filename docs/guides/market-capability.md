# How to create a Market domain capability

Domain capabilities are thin adapters from the workflow contract to **domain services**. Policy
belongs in the service (so every workflow and the API share it), not in the capability or the
workflow definition.

1. Put the logic in a domain service under `packages/market/src/<module>/` with unit tests
   (pure policy functions where possible, e.g. `jobs/lifecycle.ts`, `resolution/*.ts`).
2. Expose it on the `MarketDomain` facade if it needs wiring (`market-domain.ts`).
3. Add the capability in `packages/market/src/workflow-nodes/`:

```ts
export const reconcileCompany = defineCapability({
  type: 'market.reconcile_company',
  version: 1,
  title: 'Reconcile / Publish Company',
  description: 'Recomputes canonical company facts with provenance, confidence and conflicts.',
  category: 'domain',
  inputSchema: z.object({ companyId: z.string() }),
  outputSchema: z.object({
    companyId: z.string(),
    changed: z.boolean(),
    conflictFields: z.array(z.string()),
  }),
  configSchema: z.object({}),
  execution: { retryable: true, idempotency: 'optional', sideEffects: true },
  async execute(ctx, input) {
    const { company, changed } = await ctx.services.get(MARKET).companyReconciler.reconcile(input.companyId);
    return { companyId: company._id, changed, conflictFields: company.quality.conflictFields };
  },
});
```

4. Register it in `marketCapabilities` (`workflow-nodes/index.ts`).
5. Record provenance: observations carry `parser { name, version }`; derived facts carry
   evidence and policy versions; AI output is stored as a proposal with its metadata.
6. Raise ambiguity through `market.reviews.raise({ dedupeKey, … })` — never guess.
7. Add an integration test in `packages/market/src/market.int.test.ts` if the capability
   participates in a vertical slice.
