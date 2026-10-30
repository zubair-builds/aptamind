# Aptamind programme — post-Foundation phase

Status and machine-readable state: [`PROGRAMME_STATE.yaml`](PROGRAMME_STATE.yaml). Decisions:
[`DECISION_LOG.md`](DECISION_LOG.md). Ownership: [`STREAM_OWNERSHIP.md`](STREAM_OWNERSHIP.md).
Cross-stream contracts: [`INTEGRATION_CONTRACTS.md`](INTEGRATION_CONTRACTS.md).

## Baseline

The Foundation + Market v0.1 programme (F0, F1, M1–M5) passed its final independent freeze audit at
`d9799b6a2ae42a3799b25a1a0f39bb09bd857698` (`main`, CI run 36562072394 green). That commit is the
**Frozen Foundation v0.1 baseline**, tag `foundation-v0.1`. Its evidence trail is
[`docs/execution/market-foundation-status.md`](../execution/market-foundation-status.md).

## Streams

| Stream                        | Question it answers                                                                                 | Plan                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| A — Market Intelligence       | What companies and jobs exist, under what employment conditions, with what evidence?                | [`streams/market.md`](streams/market.md)             |
| B — Professional v0.1         | What is true about this professional, what supports it, what did they confirm, what do they target? | [`streams/professional.md`](streams/professional.md) |
| C — Admin UX (Attio-inspired) | How does an operator understand and act on all of this quickly and correctly?                       | [`streams/admin-ux.md`](streams/admin-ux.md)         |
| Supervisor                    | Architecture, integration, reviews, CI, shared contracts, release readiness.                        | this file                                            |

Opportunity Intelligence (Market × Professional → fit, gaps, viability, reachability, priority) is
**not started**. Both domains keep clean, queryable canonical models so the future join needs no
rework, and Professional Fit stays separate from Application Viability.

## Waves

| Wave | Market                                                                  | Professional                                  | Admin UX                                                    |
| ---- | ----------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| 0    | Programme bootstrap, branches, worktrees, programme memory (supervisor) |                                               |                                                             |
| 1    | Current-state audit, M6+ plan, API contracts                            | Context, PRD, domain model, P0–P8 DAG         | UX0 audit + Attio-derived design contract                   |
| 2    | Source/data-quality improvements; list API gaps                         | P0 contracts/persistence, P1 sources/evidence | UX1 tokens, shell, navigation, primitives                   |
| 3    | Live ingestion / reliability                                            | P2 extraction/assertions                      | UX2 list/property system; UX3–5 Sources/Companies/Jobs      |
| 4    | Intelligence / evaluation                                               | P3 reconciliation, P4 confirmation            | UX6 Review, UX7 Workflows/Runs                              |
| 5    | Continued coverage                                                      | P5 career targets, P6–P8                      | UX8 workflow editor, UX9 Professional surfaces, UX10 polish |

Waves overlap; a stream never waits on another — a missing dependency is recorded and the stream
takes its next independent task.

## Execution model

- One worktree per stream (`../aptamind-market`, `../aptamind-professional`, `../aptamind-admin`),
  each on its stream branch cut from `main`. The supervisor works in the primary checkout.
- Streams deliver small milestone PRs to `main`. After merge, the stream branch is reset to the new
  `main` (it holds no unmerged work) and other streams merge `main` at their next milestone boundary.
- Every PR: contract, implementation, tests, docs, migration notes. Two independent reviews
  (implementation; architecture/product), CI green, then the supervisor merges.
- Admin milestones are approved only after inspecting the running app with representative data.

## Definition of success (this phase)

- **Foundation** — frozen and stable; shared changes only via Foundation Exceptions.
- **Market** — real source coverage improving; measurable data quality; trustworthy employment
  intelligence; operators can understand provenance.
- **Professional** — truth/evidence model; sources ingested; assertions extracted; confirmed truth
  represented; canonical profile reconciled; career targets represented.
- **Admin** — coherent Attio-inspired information architecture across the whole product; fast,
  comprehensible core records; materially simpler workflow/run experience; workflow builder redesign
  underway or delivered without blocking domains.
