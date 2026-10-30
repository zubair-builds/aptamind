/**
 * Reconciliation policy `prof-rec-1` (domain doc §3.3, §6, §7.1–7.2). Pure: no I/O. The
 * revision-fenced item reconciler (P3.2) calls `reconcileItem` and persists its result.
 */
export * from './compatibility';
export * from './confidence';
export * from './requests';
export * from './policy';
