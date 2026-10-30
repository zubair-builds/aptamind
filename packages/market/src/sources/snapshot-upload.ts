import { type Actor, AppError } from '@aptamind/contracts';
import type { MarketDomain } from '../market-domain';
import {
  checkDirectoryUpload,
  COMPANY_DIRECTORY_PROVIDER,
  directoryConfigOf,
  directoryConfigWarnings,
} from './providers/company-directory';
import {
  ATS_BOARD_DIRECTORY_PROVIDER,
  boardDirectoryConfigOf,
  checkBoardDirectoryUpload,
} from './providers/ats-board-directory';
import { boardOfSource } from './source-standing';
import type { SourceDoc } from './source.schema';

/**
 * Provider checks that run BEFORE anything is stored: a refused upload leaves no artifact, no
 * snapshot and no audit of stored content (only the refusal is audited, without the content).
 */
function checkBeforeStorage(source: SourceDoc, body: Uint8Array | string, mimeType: string): void {
  const problems =
    source.provider === COMPANY_DIRECTORY_PROVIDER
      ? checkDirectoryUpload(directoryConfigOf(source), body, mimeType)
      : source.provider === ATS_BOARD_DIRECTORY_PROVIDER
        ? checkBoardDirectoryUpload(boardDirectoryConfigOf(source), body, mimeType)
        : [];
  if (!problems.length) return;
  const tooBig = problems.some((p) => p.code === 'too_large' || p.code === 'too_many_rows');
  throw new AppError(
    tooBig ? 'limit_exceeded' : 'validation_failed',
    `Upload refused: ${problems.map((p) => p.message).join('; ')}`.slice(0, 2000),
    { problems: problems.slice(0, 50).map((p) => ({ ...p })), counts: countByCode(problems) },
  );
}

function countByCode(problems: Array<{ code: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of problems) counts[p.code] = (counts[p.code] ?? 0) + 1;
  return counts;
}

function problemCounts(err: AppError): Record<string, number> {
  const counts = err.details?.counts;
  return counts && typeof counts === 'object' ? (counts as Record<string, number>) : {};
}

/**
 * Manual snapshot upload (e.g. a dataset file an operator downloaded, or a committed fixture
 * when the network is unavailable). The file becomes a normal immutable snapshot; the source's
 * workflow then processes it via `snapshotId` exactly as if it had been fetched.
 */
export async function uploadSnapshot(
  market: MarketDomain,
  sourceId: string,
  body: Uint8Array | string,
  mimeType: string,
  actor: Actor,
): Promise<{
  snapshotId: string;
  artifactId: string;
  unchanged: boolean;
  warnings: string[];
  bytes: number;
  sha256: string;
}> {
  const source = await market.sources.get(sourceId);
  try {
    checkBeforeStorage(source, body, mimeType);
  } catch (err) {
    if (err instanceof AppError)
      await market.audit.record({
        actor,
        action: 'source.snapshot_upload_refused',
        entity: { kind: 'source', id: source._id },
        // Problem codes and counts only: a refused file's text (header cells, which may be a
        // person's name or email when the header row is missing) never reaches the audit trail.
        details: { code: err.code, problems: problemCounts(err) },
      });
    throw err;
  }
  const artifact = await market.ctx.artifacts.put(body, mimeType, {
    labels: { sourceId: source._id, via: 'upload' },
  });
  const { snapshot, unchanged } = await market.observations.recordSnapshot({
    sourceId: source._id,
    artifact,
    contentType: mimeType,
    via: 'upload',
    // An upload is the source's listing as the operator supplied it: its board is the source's.
    board: boardOfSource(source),
  });
  await market.audit.record({
    actor,
    action: 'source.snapshot_uploaded',
    entity: { kind: 'source', id: source._id },
    details: {
      snapshotId: snapshot._id,
      artifactId: artifact.artifactId,
      bytes: artifact.size,
      sha256: artifact.sha256,
    },
  });
  // Import-wide warnings the column map implies (e.g. every row will go to review).
  const warnings =
    source.provider === COMPANY_DIRECTORY_PROVIDER ? directoryConfigWarnings(directoryConfigOf(source)) : [];
  return {
    snapshotId: snapshot._id,
    artifactId: artifact.artifactId,
    unchanged,
    warnings,
    bytes: artifact.size,
    sha256: artifact.sha256,
  };
}
