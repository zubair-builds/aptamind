'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { ActionState } from './action-state';
import { type ApiFailure, type ApiResult, apiPatch, apiPost, apiRequest, seg } from './api';
import { uploadContentType } from './upload';

/*
 * Server Actions: every mutation goes through the internal API, then revalidates the page
 * it came from. Results (or API errors) are returned as ActionState and rendered inline.
 */

function str(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

function required(fd: FormData, name: string): string {
  const v = str(fd, name);
  if (!v) throw new InputError(`Missing ${name}`);
  return v;
}

class InputError extends Error {}

function failure(e: ApiFailure): ActionState {
  let details: string | undefined;
  if (e.details !== undefined) {
    try {
      details = JSON.stringify(e.details, null, 2).slice(0, 4000);
    } catch {
      details = String(e.details);
    }
  }
  return {
    status: 'error',
    code: e.kind === 'unavailable' ? 'api_unavailable' : e.code,
    message: `${e.message}${e.status ? ` (HTTP ${e.status})` : ''}`,
    details,
  };
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new InputError(`${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  if (!text) return {};
  const v = parseJson(text, what);
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new InputError(`${what} must be a JSON object`);
  return v as Record<string, unknown>;
}

function revalidate(fd: FormData, ...paths: string[]) {
  const from = str(fd, 'revalidate');
  for (const p of [from, ...paths]) if (p && p.startsWith('/')) revalidatePath(p);
}

async function guard(fn: () => Promise<ActionState>): Promise<ActionState> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InputError) return { status: 'error', code: 'invalid_input', message: err.message };
    throw err;
  }
}

function runStarted<T extends { runId?: string | null }>(
  res: ApiResult<T>,
  fd: FormData,
  message: string,
): ActionState {
  if (!res.ok) return failure(res.error);
  revalidate(fd, '/runs');
  const runId = res.data.runId ?? undefined;
  return runId
    ? {
        status: 'ok',
        message: `${message} Run ${runId}.`,
        href: `/runs/${seg(runId)}`,
        hrefLabel: 'Open run',
      }
    : { status: 'ok', message };
}

// ------------------------------------------------------------------ sources

export async function runSourceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const id = required(fd, 'sourceId');
    const res = await apiPost<{ runId: string }>(`/api/sources/${seg(id)}/run`, {});
    return runStarted(res, fd, 'Source run started.');
  });
}

export async function setSourceEnabledAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const id = required(fd, 'sourceId');
    const enabled = required(fd, 'enabled') === 'true';
    const res = await apiPost<{ source: { enabled: boolean } }>(
      `/api/sources/${seg(id)}/${enabled ? 'enable' : 'disable'}`,
      {},
    );
    if (!res.ok) return failure(res.error);
    revalidate(fd, '/sources');
    return { status: 'ok', message: `Source ${res.data.source.enabled ? 'enabled' : 'disabled'}.` };
  });
}

export async function uploadSnapshotAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const id = required(fd, 'sourceId');
    const file = fd.get('file');
    if (!(file instanceof File) || file.size === 0) throw new InputError('Choose a non-empty file to upload');
    const contentType = uploadContentType(file, str(fd, 'contentType'));
    const process = fd.get('process') === 'on' ? 'true' : 'false';
    const res = await apiRequest<{ snapshotId: string; runId: string | null; created?: boolean }>(
      `/api/sources/${seg(id)}/snapshots`,
      {
        method: 'POST',
        query: { process },
        raw: { body: await file.arrayBuffer(), contentType },
        timeoutMs: 300_000,
      },
    );
    if (!res.ok) return failure(res.error);
    revalidate(fd);
    const { snapshotId, runId } = res.data;
    return runId
      ? {
          status: 'ok',
          message: `Uploaded ${file.name} (${contentType}) as snapshot ${snapshotId}; processing run ${runId} started.`,
          href: `/runs/${seg(runId)}`,
          hrefLabel: 'Open run',
        }
      : {
          status: 'ok',
          message: `Uploaded ${file.name} (${contentType}) as snapshot ${snapshotId} (not processed).`,
          href: `/snapshots/${seg(snapshotId)}`,
          hrefLabel: 'Open snapshot',
        };
  });
}

export async function reprocessSnapshotAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const id = required(fd, 'snapshotId');
    const res = await apiPost<{ runId: string }>(`/api/snapshots/${seg(id)}/reprocess`, {});
    return runStarted(res, fd, 'Reprocessing started.');
  });
}

export async function createSourceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let target: string | null = null;
  const state = await guard(async () => {
    const body = parseJsonObject(required(fd, 'definition'), 'Source definition');
    const res = await apiPost<{ source: { _id: string; key: string }; created: boolean }>(
      '/api/sources',
      body,
    );
    if (!res.ok) return failure(res.error);
    revalidatePath('/sources');
    if (!res.data.created) {
      return {
        status: 'ok',
        message: `A source with key "${res.data.source.key}" already exists; nothing was created.`,
        href: `/sources/${seg(res.data.source._id)}`,
        hrefLabel: 'Open existing source',
      };
    }
    target = `/sources/${seg(res.data.source._id)}`;
    return { status: 'ok', message: 'Source created.' };
  });
  if (target) redirect(target);
  return state;
}

export async function updateSourceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const id = required(fd, 'sourceId');
    const patch = parseJsonObject(required(fd, 'patch'), 'Patch');
    const res = await apiPatch<{ source: unknown }>(`/api/sources/${seg(id)}`, patch);
    if (!res.ok) return failure(res.error);
    revalidate(fd, '/sources');
    return { status: 'ok', message: 'Source updated.' };
  });
}

// ------------------------------------------------------------------ workflows & runs

export async function setScheduleEnabledAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const id = required(fd, 'scheduleId');
    const enabled = required(fd, 'enabled') === 'true';
    const res = await apiPost<{ ok: boolean }>(
      `/api/schedules/${seg(id)}/${enabled ? 'enable' : 'disable'}`,
      {},
    );
    if (!res.ok) return failure(res.error);
    revalidate(fd, '/workflows');
    return { status: 'ok', message: `Schedule ${enabled ? 'enabled' : 'disabled'}.` };
  });
}

export async function startWorkflowRunAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const key = required(fd, 'workflowKey');
    const input = parseJsonObject(str(fd, 'input') || '{}', 'Run input');
    const versionText = str(fd, 'version');
    const idempotencyKey = str(fd, 'idempotencyKey');
    const body: Record<string, unknown> = { input };
    if (versionText) {
      const v = Number.parseInt(versionText, 10);
      if (!Number.isInteger(v) || v < 1) throw new InputError('Version must be a positive integer');
      body.version = v;
    }
    if (idempotencyKey) body.idempotencyKey = idempotencyKey;
    const res = await apiPost<{ runId: string; state: string }>(`/api/workflows/${seg(key)}/runs`, body);
    return runStarted(res, fd, `Workflow ${key} started.`);
  });
}

export async function cancelRunAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const id = required(fd, 'runId');
    const res = await apiPost<{ run: { state: string } }>(`/api/runs/${seg(id)}/cancel`, {});
    if (!res.ok) return failure(res.error);
    revalidate(fd, '/runs');
    return { status: 'ok', message: `Cancellation requested (state: ${res.data.run?.state ?? 'unknown'}).` };
  });
}

export async function retryNodeRunAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const id = required(fd, 'nodeRunId');
    const res = await apiPost<{ nodeRun: { state: string } }>(`/api/node-runs/${seg(id)}/retry`, {});
    if (!res.ok) return failure(res.error);
    revalidate(fd, '/runs');
    return {
      status: 'ok',
      message: `Node retry requested (state: ${res.data.nodeRun?.state ?? 'unknown'}).`,
    };
  });
}

export async function resumeNodeRunAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const id = required(fd, 'nodeRunId');
    const payload = parseJsonObject(str(fd, 'payload') || '{}', 'Resume payload');
    const res = await apiPost<{ nodeRun: { state: string } }>(`/api/node-runs/${seg(id)}/resume`, {
      payload,
    });
    if (!res.ok) return failure(res.error);
    revalidate(fd, '/runs');
    return { status: 'ok', message: `Node resumed (state: ${res.data.nodeRun?.state ?? 'unknown'}).` };
  });
}

// ------------------------------------------------------------------ companies & jobs

export async function discoverCareersAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const id = required(fd, 'companyId');
    const res = await apiPost<{ runId: string }>(`/api/companies/${seg(id)}/discover-careers`, {});
    return runStarted(res, fd, 'Careers discovery started.');
  });
}

export async function reconcileCompanyAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const id = required(fd, 'companyId');
    const res = await apiPost<{ companyId: string; changed: boolean }>(
      `/api/companies/${seg(id)}/reconcile`,
      {},
    );
    if (!res.ok) return failure(res.error);
    revalidate(fd, '/companies');
    return {
      status: 'ok',
      message: res.data.changed ? 'Reconciled: canonical data changed.' : 'Reconciled: no changes.',
    };
  });
}

export async function verifyJobAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const id = required(fd, 'jobId');
    const res = await apiPost<{ runId: string }>(`/api/jobs/${seg(id)}/verify`, {});
    return runStarted(res, fd, 'Verification started.');
  });
}

export async function reinterpretJobAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const id = required(fd, 'jobId');
    const res = await apiPost<{ runId: string }>(`/api/jobs/${seg(id)}/reinterpret`, {});
    return runStarted(res, fd, 'Re-interpretation started.');
  });
}

// ------------------------------------------------------------------ review

export async function resolveReviewAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const id = required(fd, 'reviewId');
    const action = required(fd, 'action');
    const reason = str(fd, 'reason');
    if (reason.length < 3) throw new InputError('A reason of at least 3 characters is required');
    const body: Record<string, unknown> = { action, reason };
    const targetId = str(fd, 'targetId');
    if (targetId) body.targetId = targetId;
    const field = str(fd, 'field');
    const valueText = str(fd, 'value');
    if (action === 'correct') {
      if (!field) throw new InputError('Field is required for "correct"');
      if (!valueText) throw new InputError('A JSON value is required for "correct"');
    }
    if (field) body.field = field;
    if (valueText) body.value = parseJson(valueText, 'Value');
    const res = await apiPost<{ item: { status: string; resolution?: { result?: unknown } } }>(
      `/api/review/${seg(id)}/resolve`,
      body,
    );
    if (!res.ok) return failure(res.error);
    revalidate(fd, '/review', '/');
    const result = res.data.item.resolution?.result;
    return {
      status: 'ok',
      message: `Review item ${res.data.item.status}.${result ? ` Result: ${JSON.stringify(result)}` : ''}`,
    };
  });
}
