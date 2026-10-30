import path from 'node:path';
import fs from 'node:fs';

/** Committed fixture data (development seed, tests, golden evaluation). Source-tree only. */
const workspaceFixtures = path.resolve(process.cwd(), 'packages/market/fixtures');
const packageFixtures = path.resolve(process.cwd(), '../../packages/market/fixtures');
const candidates = [workspaceFixtures, packageFixtures];

export const MARKET_FIXTURES_DIR =
  candidates.find((candidate) => fs.existsSync(candidate)) ?? workspaceFixtures;
