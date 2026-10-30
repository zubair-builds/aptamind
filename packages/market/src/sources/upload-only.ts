import { AppError } from '@aptamind/contracts';
import { ATS_BOARD_DIRECTORY_PROVIDER, ATS_BOARD_DIRECTORY_WORKFLOW } from './providers/ats-board-directory';
import { COMPANY_DIRECTORY_PROVIDER, COMPANY_DIRECTORY_WORKFLOW } from './providers/company-directory';

/**
 * Upload-only providers and the one workflow each may run. Every file of such a source passes the
 * provider's checks before storage (`uploadSnapshot`), so nothing may fetch for it: no endpoint
 * URL, no schedule, no other workflow, and every run names an uploaded snapshot.
 */
export const UPLOAD_ONLY_PROVIDERS: Readonly<Record<string, string>> = {
  [COMPANY_DIRECTORY_PROVIDER]: COMPANY_DIRECTORY_WORKFLOW,
  [ATS_BOARD_DIRECTORY_PROVIDER]: ATS_BOARD_DIRECTORY_WORKFLOW,
};

export function isUploadOnly(provider: string): boolean {
  return Object.hasOwn(UPLOAD_ONLY_PROVIDERS, provider);
}

/**
 * Throws 400 `validation_failed` unless a run of `workflowKey` with `input` may start for
 * `source`: for an upload-only provider, only its pinned workflow, and only with a `snapshotId`
 * (an uploaded file). Other providers are unrestricted.
 */
export function assertLaunchable(
  source: { key: string; provider: string },
  workflowKey: string,
  input: Record<string, unknown>,
): void {
  if (!isUploadOnly(source.provider)) return;
  const pinned = UPLOAD_ONLY_PROVIDERS[source.provider]!;
  if (workflowKey !== pinned)
    throw new AppError(
      'validation_failed',
      `Source ${source.key} is upload-only: only ${pinned} may run for it (not ${workflowKey})`,
      { workflowKey, allowed: pinned },
    );
  if (typeof input.snapshotId !== 'string' || !input.snapshotId)
    throw new AppError(
      'validation_failed',
      `Source ${source.key} is upload-only: upload a file (POST /api/sources/:id/snapshots) and run it with its snapshotId`,
      { param: 'snapshotId' },
    );
}
