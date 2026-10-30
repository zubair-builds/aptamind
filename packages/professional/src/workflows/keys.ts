/**
 * Workflow keys of the Professional templates. The `professional.` prefix is how the platform
 * recognizes Professional runs: their artifact refs are not listed by generic run views (FE-P6)
 * and the generic run-start route refuses them (they start only through Professional services).
 */
export const PROFESSIONAL_INGEST_WORKFLOW = 'professional.source.ingest';
