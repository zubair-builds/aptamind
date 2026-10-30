import { ref, type WorkflowSpec } from '@aptamind/workflow-sdk';
import { PROFESSIONAL_INGEST_WORKFLOW } from './keys';

export { PROFESSIONAL_INGEST_WORKFLOW } from './keys';

/**
 * Professional workflow templates (`professional.*`, code-authored, versioned on
 * registration). They only compose capabilities; business rules live in the domain. Run input
 * and labels are opaque ids (R-34).
 */

/** Ingest one snapshot: load → structured extraction (text/semantic extraction join in P2). */
export const sourceIngest: WorkflowSpec = {
  key: PROFESSIONAL_INGEST_WORKFLOW,
  title: 'Professional source ingest',
  description:
    'Processes one stored snapshot of a subject source: checks it, then runs the deterministic structured extractor. Re-running writes nothing new (extraction ledger).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['subjectId', 'sourceId', 'snapshotId'],
    properties: {
      subjectId: { type: 'string', pattern: '^psub_[A-Za-z0-9]+$' },
      sourceId: { type: 'string', pattern: '^psrc_[A-Za-z0-9]+$' },
      snapshotId: { type: 'string', pattern: '^psnap_[A-Za-z0-9]+$' },
    },
  },
  nodes: [
    {
      id: 'trigger',
      capability: { type: 'core.manual_trigger', version: 1 },
      input: { payload: ref('run.input') },
    },
    {
      id: 'load',
      title: 'Load snapshot',
      capability: { type: 'professional.load_snapshot', version: 1 },
      input: {
        subjectId: ref('nodes.trigger.output.payload.subjectId'),
        sourceId: ref('nodes.trigger.output.payload.sourceId'),
        snapshotId: ref('nodes.trigger.output.payload.snapshotId'),
      },
    },
    {
      id: 'extract_structured',
      title: 'Extract structured statements',
      capability: { type: 'professional.extract_structured', version: 1 },
      input: { snapshotId: ref('nodes.load.output.snapshotId') },
      retry: { maxAttempts: 3, backoffMs: 1_000 },
    },
  ],
  edges: [
    { from: 'trigger', to: 'load' },
    { from: 'load', to: 'extract_structured' },
  ],
};

export const professionalWorkflows: WorkflowSpec[] = [sourceIngest];
