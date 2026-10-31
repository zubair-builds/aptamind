'use server';

import { revalidatePath } from 'next/cache';
import { type ApiFailure, apiGet, apiPatch, apiPost, seg } from './api';
import { IMPORT_KINDS, isMappedImportType, type MappedImportType, sameColumns } from './import-mapping';
import { type ImportProblem, problemsOf } from './import-problems';
import { createImport } from './imports';
import type { JsonObject, SourceDetail } from './types';
import { uploadContentType } from './upload';

/*
 * Server Actions behind the import wizard. The browser has already removed unmapped columns; these
 * only talk to the internal API (create or update the target list, then upload) and report back.
 */

export type ImportActionResult =
  | { ok: true; importId: string }
  | {
      ok: false;
      /** Which call failed: the list (create / save mapping) or the upload. */
      stage: 'input' | 'source' | 'upload';
      code: string;
      message: string;
      problems: ImportProblem[];
      requestId?: string;
      /** A list created by this attempt: retry against it instead of creating another. */
      createdSourceId?: string;
    };

class InputError extends Error {}

function text(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

function fail(stage: 'source' | 'upload', e: ApiFailure, createdSourceId?: string): ImportActionResult {
  return {
    ok: false,
    stage,
    code: e.kind === 'unavailable' ? 'api_unavailable' : e.code,
    message: `${e.message}${e.status ? ` (HTTP ${e.status})` : ''}`,
    problems: problemsOf(e.details),
    ...(e.requestId ? { requestId: e.requestId } : {}),
    ...(createdSourceId ? { createdSourceId } : {}),
  };
}

const NAME = /^[\s\S]{1,200}$/;
const NAMESPACE = /^[a-z][a-z0-9_]{1,40}$/;

/** The column map exactly as the wizard built it; anything else is refused before any API call. */
function parseColumns(type: MappedImportType, raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InputError('The column mapping is not valid.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InputError('The column mapping is not valid.');
  const allowed = new Set(IMPORT_KINDS[type].fields.map((f) => f.key.split('.')[0]!));
  for (const [k, v] of Object.entries(value)) {
    if (!allowed.has(k)) throw new InputError(`Unknown field "${k}" in the column mapping.`);
    if (k === 'registerIds') {
      if (!v || typeof v !== 'object' || Array.isArray(v))
        throw new InputError('The register id mapping is not valid.');
      for (const [ns, col] of Object.entries(v))
        if (!NAMESPACE.test(ns) || typeof col !== 'string' || !NAME.test(col))
          throw new InputError('The register id mapping is not valid.');
    } else if (typeof v !== 'string' || !NAME.test(v)) throw new InputError(`Field "${k}" has no column.`);
  }
  return value as Record<string, unknown>;
}

/** Source keys must be unique; the time suffix keeps two lists with the same name apart. */
function sourceKey(provider: string, name: string): string {
  const slug =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'list';
  return `${provider}:${slug}-${Date.now().toString(36)}`;
}

/** Upload-only list (market-sources.md M8.1): no endpoint, no schedule, default authority. */
function newSourceBody(type: MappedImportType, name: string, config: JsonObject) {
  const kind = IMPORT_KINDS[type];
  return {
    key: sourceKey(kind.provider, name),
    name,
    category: kind.category,
    provider: kind.provider,
    acquisition: { workflowKey: kind.workflowKey, config },
    freshness: { policyClass: kind.policyClass, maxAgeMinutes: 100_000 },
    governance: { accessMethod: 'manual_upload' },
  };
}

/**
 * Makes sure the existing list maps columns the same way; saves the new mapping otherwise. The
 * rest of the saved config (size limits) is kept: `PATCH` replaces `acquisition.config` whole.
 * This runs before the upload on purpose: the server checks the uploaded header against the
 * source's saved columns, so an upload sent first would be refused as unmapped or missing columns.
 */
async function syncMapping(
  type: MappedImportType,
  sourceId: string,
  columns: Record<string, unknown>,
  defaultCountry: string | undefined,
): Promise<ApiFailure | string | null> {
  const res = await apiGet<SourceDetail>(`/api/sources/${seg(sourceId)}`);
  if (!res.ok) return res.error;
  const source = res.data.source;
  if (source.provider !== IMPORT_KINDS[type].provider)
    return `"${source.name}" is not a ${IMPORT_KINDS[type].label.toLowerCase()} list.`;
  const current = (source.acquisition.config ?? {}) as JsonObject;
  const sameCountry = type !== 'companies' || (current.defaultCountry ?? undefined) === defaultCountry;
  if (sameColumns(current.columns, columns) && sameCountry) return null;
  const config: JsonObject = { ...current, columns: columns as JsonObject };
  if (type === 'companies') {
    if (defaultCountry) config.defaultCountry = defaultCountry;
    else delete config.defaultCountry;
  }
  const patched = await apiPatch(`/api/sources/${seg(sourceId)}`, { acquisition: { config } });
  return patched.ok ? null : patched.error;
}

/** Companies, known ATS boards or job links: target list, then the reduced CSV upload. */
export async function startMappedImportAction(fd: FormData): Promise<ImportActionResult> {
  let createdSourceId: string | undefined;
  try {
    const type = text(fd, 'type');
    if (!isMappedImportType(type)) throw new InputError('Unknown import type.');
    const fileName = text(fd, 'fileName');
    if (!fileName) throw new InputError('The file has no name.');
    const file = fd.get('file');
    if (!(file instanceof Blob) || file.size === 0) throw new InputError('The file to upload is empty.');
    const columns = parseColumns(type, text(fd, 'columns'));
    const defaultCountry = text(fd, 'defaultCountry').toUpperCase() || undefined;
    if (defaultCountry && !/^[A-Z]{2}$/.test(defaultCountry))
      throw new InputError('Default country must be a two-letter country code, such as GB.');

    let sourceId = text(fd, 'sourceId');
    if (text(fd, 'target') === 'new') {
      const name = text(fd, 'sourceName');
      if (!name) throw new InputError('Give the new list a name.');
      const config: JsonObject = { columns: columns as JsonObject };
      if (type === 'companies' && defaultCountry) config.defaultCountry = defaultCountry;
      const created = await apiPost<{ source: { _id: string }; created: boolean }>(
        '/api/sources',
        newSourceBody(type, name, config),
      );
      if (!created.ok) return fail('source', created.error);
      sourceId = created.data.source._id;
      createdSourceId = created.data.created ? sourceId : undefined;
      revalidatePath('/sources');
      // An existing key returns that source unchanged: its mapping may differ.
      if (!created.data.created) {
        const synced = await syncMapping(type, sourceId, columns, defaultCountry);
        if (typeof synced === 'string') throw new InputError(synced);
        if (synced) return fail('source', synced);
      }
    } else {
      if (!sourceId) throw new InputError('Choose a list to import into.');
      const synced = await syncMapping(type, sourceId, columns, defaultCountry);
      if (typeof synced === 'string') throw new InputError(synced);
      if (synced) return fail('source', synced);
    }

    const res = await createImport({
      type,
      sourceId,
      fileName,
      body: await file.arrayBuffer(),
      contentType: 'text/csv',
    });
    if (!res.ok) return fail('upload', res.error, createdSourceId);
    revalidatePath('/imports');
    return { ok: true, importId: res.data._id };
  } catch (err) {
    if (err instanceof InputError)
      return {
        ok: false,
        stage: 'input',
        code: 'invalid_input',
        message: err.message,
        problems: [],
        ...(createdSourceId ? { createdSourceId } : {}),
      };
    throw err;
  }
}

/** Generic snapshot: the file goes to the source as it is, in the source's own format. */
export async function startSnapshotImportAction(fd: FormData): Promise<ImportActionResult> {
  const sourceId = text(fd, 'sourceId');
  const file = fd.get('file');
  if (!sourceId)
    return { ok: false, stage: 'input', code: 'invalid_input', message: 'Choose a source.', problems: [] };
  if (!(file instanceof File) || file.size === 0)
    return {
      ok: false,
      stage: 'input',
      code: 'invalid_input',
      message: 'Choose a non-empty file.',
      problems: [],
    };
  const res = await createImport({
    type: 'snapshot',
    sourceId,
    fileName: file.name,
    body: await file.arrayBuffer(),
    contentType: uploadContentType(file),
  });
  if (!res.ok) return fail('upload', res.error);
  revalidatePath('/imports');
  return { ok: true, importId: res.data._id };
}
