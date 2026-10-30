import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Committed fixture data (development seed, tests, golden evaluation). Source-tree only.
 * Resolved relative to this module (not process.cwd()), so it works from any package's
 * working directory, e.g. under `pnpm --filter <pkg> ...`.
 */
export const MARKET_FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
