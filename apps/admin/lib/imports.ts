import { apiGet, apiRequest, type Query, seg } from './api';
import type { ImportDetail, ImportStatus, ImportSummary, ImportType } from './types';

/* Imports API client (market-imports.md). Server-side only, like `api.ts`. */

export interface ImportListQuery extends Query {
  type?: ImportType;
  status?: ImportStatus;
  sourceId?: string;
  cursor?: string;
  limit?: number;
}

export const listImports = (query: ImportListQuery = {}) =>
  apiGet<{ items: ImportSummary[]; nextCursor: string | null }>('/api/imports', query);

export const getImport = (id: string) => apiGet<ImportDetail>(`/api/imports/${seg(id)}`);

/** Uploads the file and starts the run. Refused files (`details.problems[]`) create no record. */
export const createImport = (input: {
  type: ImportType;
  sourceId: string;
  fileName: string;
  body: ArrayBuffer | string;
  contentType: string;
}) =>
  apiRequest<ImportDetail>('/api/imports', {
    method: 'POST',
    query: { type: input.type, sourceId: input.sourceId, fileName: input.fileName },
    raw: { body: input.body, contentType: input.contentType },
    // Same budget as the source snapshot upload: large files take a while to stream.
    timeoutMs: 300_000,
  });
