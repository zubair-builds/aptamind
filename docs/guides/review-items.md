# How to resolve review items

1. Admin → **Review** (ordered by priority, then age). Filter by type or entity.
2. Open an item: subject, reason, severity, evidence (source/observation/artifact/quote), the
   observations involved and side-by-side candidates.
3. Choose one of the item's allowed actions and give a reason (required):
   - `merge` — pick the target candidate (company resolution attaches the observations to it;
     duplicates merge into the older entity, leaving an audited tombstone);
   - `create_new` — the candidate is a distinct company (created with a qualified identity key
     and marked distinct from the candidates);
   - `keep_separate` — two entities are distinct (suppresses repeated duplicate reviews);
   - `correct` — `field` + JSON `value` (job overrides or operator company observations);
   - `retry` — re-run the source / re-interpret after a fix;
   - `reject` — the observation is wrong or irrelevant; `confirm`; `dismiss`.
4. The decision is applied immediately, audited (`GET /api/audit?entityId=…`) and resumes any
   workflow node waiting on the item.

API: `POST /api/review/:id/resolve` with `{ "action": "merge", "targetId": "cmp_…", "reason": "…" }`.
See the [review queue runbook](../runbooks/review-queue.md) for per-type guidance.
