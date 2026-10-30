import type { AnyCapability } from '@aptamind/workflow-sdk';
import { aiExtract } from './nodes/ai';
import { loadArtifact, storeArtifact } from './nodes/artifacts';
import { browserCrawl, browserFetch } from './nodes/browser';
import { executeSubworkflow, ifCapability, switchCapability } from './nodes/control';
import { httpRequest } from './nodes/http';
import { parseCsvCapability, parseJsonCapability } from './nodes/parse';
import { dedupeRecords, filterRecords, mapFields } from './nodes/transform';
import { manualTrigger, scheduleTrigger } from './nodes/triggers';

export * from './tokens';
export * from './browser';
export { extractLinks } from './nodes/browser';
export { evaluateCondition, mapRecord, conditionSchema } from './nodes/transform';
export { getPath, setPath } from './nodes/paths';
export { aiMetaSchema } from './nodes/ai';
export { hostScopeSchema } from './nodes/http';
export {
  aiExtract,
  browserCrawl,
  browserFetch,
  dedupeRecords,
  executeSubworkflow,
  filterRecords,
  httpRequest,
  ifCapability,
  loadArtifact,
  manualTrigger,
  mapFields,
  parseCsvCapability,
  parseJsonCapability,
  scheduleTrigger,
  storeArtifact,
  switchCapability,
};

/**
 * The generic capability set. `core.for_each` lives in `@aptamind/workflows` because the
 * engine implements it; register both.
 */
export const genericCapabilities: AnyCapability[] = [
  manualTrigger,
  scheduleTrigger,
  httpRequest,
  browserFetch,
  browserCrawl,
  parseCsvCapability,
  parseJsonCapability,
  mapFields,
  filterRecords,
  dedupeRecords,
  ifCapability,
  switchCapability,
  executeSubworkflow,
  storeArtifact,
  loadArtifact,
  aiExtract,
];
