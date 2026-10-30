/**
 * The api/worker bundles inline workspace packages but keep third-party modules external,
 * so every third-party runtime dependency of the workspace packages an app uses must be
 * declared by the app itself. Fails with the missing names otherwise.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) =>
  JSON.parse(readFileSync(p, 'utf8')) as { name: string; dependencies?: Record<string, string> };
const packages = new Map(
  readdirSync(path.join(root, 'packages')).map((d) => {
    const pkg = read(path.join(root, 'packages', d, 'package.json'));
    return [pkg.name, pkg] as const;
  }),
);

let failed = false;
for (const app of ['api', 'worker']) {
  const pkg = read(path.join(root, 'apps', app, 'package.json'));
  const declared = new Set(Object.keys(pkg.dependencies ?? {}));
  const needed = new Set<string>();
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const p = packages.get(name);
    if (!p) return;
    for (const dep of Object.keys(p.dependencies ?? {})) {
      if (dep.startsWith('@aptamind/')) visit(dep);
      else needed.add(dep);
    }
  };
  for (const dep of declared) if (dep.startsWith('@aptamind/')) visit(dep);
  const missing = [...needed].filter((d) => !declared.has(d)).sort();
  if (missing.length) {
    failed = true;
    console.error(`apps/${app} must declare: ${missing.join(', ')}`);
  }
}
if (failed) process.exit(1);
console.log('app runtime dependencies are complete');
