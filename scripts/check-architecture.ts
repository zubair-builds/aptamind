/**
 * Architecture guard (runs in `pnpm check` and CI). Enforces, from package manifests AND
 * source imports:
 *
 *  1. Package layering: every internal dependency must be allowed by `ALLOWED` below. In
 *     particular no shared/generic package may depend on a domain package (Market today;
 *     Professional/Opportunity later), and domain packages never depend on each other.
 *  2. Declared imports: a source file may only import internal packages its package declares
 *     (devDependencies only from tests and test support).
 *  3. Runtime internals: inside `packages/workflows`, the queue (BullMQ/Redis) is confined to
 *     the transport adapter and worker host — the engine core only sees the `Dispatcher`
 *     port — and the pure policy modules perform no I/O at all.
 *
 * Fails with every violation listed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

/** Domain packages. A new domain (e.g. professional, opportunity) is added here. */
const DOMAIN = new Set(['@aptamind/market', '@aptamind/professional']);

/** Allowed internal dependencies per package (production and dev). */
const ALLOWED: Record<string, string[]> = {
  '@aptamind/contracts': [],
  '@aptamind/config': [],
  '@aptamind/observability': [],
  '@aptamind/provenance': [],
  '@aptamind/taxonomy': [],
  '@aptamind/queue': [],
  '@aptamind/db': ['contracts'],
  '@aptamind/storage': ['contracts', 'db'],
  '@aptamind/net': ['contracts'],
  '@aptamind/ai': ['contracts'],
  // Generic workflow runtime: contracts + infrastructure only.
  '@aptamind/workflow-sdk': ['contracts'],
  '@aptamind/workflows': ['contracts', 'db', 'observability', 'queue', 'storage', 'workflow-sdk'],
  // Generic capabilities depend on the SDK contract, never on the engine.
  '@aptamind/workflow-nodes': ['ai', 'contracts', 'net', 'workflow-sdk'],
  '@aptamind/testing': [
    'ai',
    'config',
    'contracts',
    'db',
    'net',
    'observability',
    'queue',
    'storage',
    'workflow-nodes',
    'workflow-sdk',
    'workflows',
  ],
  // Domain: capabilities + ports. The engine itself is a dev dependency (test harness only).
  '@aptamind/market': [
    'ai',
    'contracts',
    'db',
    'net',
    'observability',
    'provenance',
    'storage',
    'taxonomy',
    'workflow-nodes',
    'workflow-sdk',
    'dev:workflows',
    'dev:testing',
  ],
  // Same allow-list as Market (ADR-0020); domains never depend on each other.
  '@aptamind/professional': [
    'ai',
    'contracts',
    'db',
    'net',
    'observability',
    'provenance',
    'storage',
    'taxonomy',
    'workflow-nodes',
    'workflow-sdk',
    'dev:workflows',
    'dev:testing',
  ],
  // Composition-level identity (ADR-0022): users, workspaces, permissions. Not a domain.
  '@aptamind/identity': ['contracts', 'db', 'config', 'observability'],
  // Composition root.
  '@aptamind/platform': [
    'ai',
    'config',
    'contracts',
    'db',
    'market',
    'net',
    'observability',
    'professional',
    'queue',
    'storage',
    'workflow-nodes',
    'workflow-sdk',
    'workflows',
  ],
  '@aptamind/worker': [
    'contracts',
    'identity',
    'market',
    'observability',
    'platform',
    'professional',
    'workflows',
  ],
  '@aptamind/admin': [
    'contracts',
    'identity',
    'market',
    'observability',
    'platform',
    'professional',
    'provenance',
    'workflows',
    'dev:testing',
  ],
};

/** Inside packages/workflows/src: files allowed to touch the queue. */
const QUEUE_IMPORTS = /^(@aptamind\/queue|bullmq|ioredis)$/;
const QUEUE_ALLOWED_FILES = new Set(['dispatcher.ts', 'worker-host.ts', 'runtime.ts']);
/** Pure policy modules: no persistence, queue, storage or network imports. */
const PURE_FILES = [
  'graph.ts',
  'retry-policy.ts',
  'state-machine.ts',
  'triggers.ts',
  'refs.ts',
  'execution-guard.ts',
];
const IO_IMPORTS = /^(mongodb|bullmq|ioredis|@aptamind\/(db|queue|storage|net|ai))$/;

type Pkg = {
  name: string;
  dir: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const violations: string[] = [];
const internal = (deps: Record<string, string> = {}) =>
  Object.keys(deps).filter((d) => d.startsWith('@aptamind/'));

const pkgs: Pkg[] = ['packages', 'apps'].flatMap((group) =>
  readdirSync(path.join(root, group)).map((d) => {
    const dir = path.join(root, group, d);
    return { ...(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Pkg), dir };
  }),
);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === 'dist' || e === '.next') continue;
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e) && !e.endsWith('.d.ts')) out.push(p);
    }
  };
  for (const sub of ['src', 'app', 'lib', 'components']) {
    try {
      if (statSync(path.join(dir, sub)).isDirectory()) walk(path.join(dir, sub));
    } catch {
      /* not present */
    }
  }
  return out;
}

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const specs = new Set<string>();
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g))
    specs.add(m[1] as string);
  return [...specs].map((s) =>
    s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : (s.split('/')[0] as string),
  );
}

const isTestFile = (f: string) => /\.(int\.)?test\.tsx?$/.test(f) || /(test-harness|fixtures?)[/.]/.test(f);

for (const pkg of pkgs) {
  const allowed = ALLOWED[pkg.name];
  if (!allowed) {
    violations.push(`${pkg.name}: no layering policy in scripts/check-architecture.ts (add it deliberately)`);
    continue;
  }
  const prod = new Set(allowed.filter((a) => !a.startsWith('dev:')).map((a) => `@aptamind/${a}`));
  const dev = new Set(allowed.map((a) => `@aptamind/${a.replace(/^dev:/, '')}`));

  // 1. Manifest layering.
  for (const d of internal(pkg.dependencies)) {
    if (!prod.has(d)) violations.push(`${pkg.name}: dependency on ${d} is not allowed`);
  }
  for (const d of internal(pkg.devDependencies)) {
    if (!dev.has(d)) violations.push(`${pkg.name}: devDependency on ${d} is not allowed`);
  }
  if (
    !DOMAIN.has(pkg.name) &&
    !['@aptamind/platform', '@aptamind/admin', '@aptamind/worker'].includes(pkg.name)
  ) {
    for (const d of [...internal(pkg.dependencies), ...internal(pkg.devDependencies)]) {
      if (DOMAIN.has(d)) violations.push(`${pkg.name}: shared package depends on domain package ${d}`);
    }
  }
  if (DOMAIN.has(pkg.name)) {
    for (const d of internal(pkg.dependencies)) {
      if (DOMAIN.has(d)) violations.push(`${pkg.name}: domain packages must not depend on each other (${d})`);
    }
  }

  // 2. Source imports must be declared (dev deps only from tests / test support).
  const declaredProd = new Set(internal(pkg.dependencies));
  const declaredAll = new Set([...declaredProd, ...internal(pkg.devDependencies)]);
  for (const file of sourceFiles(pkg.dir)) {
    const rel = path.relative(root, file);
    for (const spec of importsOf(file)) {
      if (!spec.startsWith('@aptamind/') || spec === pkg.name) continue;
      const ok = isTestFile(file) ? declaredAll.has(spec) : declaredProd.has(spec);
      if (!ok)
        violations.push(
          `${rel}: imports ${spec}, not declared as a ${isTestFile(file) ? '' : 'production '}dependency of ${pkg.name}`,
        );
      if (
        DOMAIN.has(spec) &&
        !DOMAIN.has(pkg.name) &&
        !['@aptamind/platform', '@aptamind/admin', '@aptamind/worker'].includes(pkg.name)
      ) {
        violations.push(`${rel}: shared code imports domain package ${spec}`);
      }
    }
  }
}

// 3. Runtime internals.
const wfSrc = path.join(root, 'packages/workflows/src');
for (const file of sourceFiles(path.join(root, 'packages/workflows'))) {
  const rel = path.relative(wfSrc, file);
  const imports = importsOf(file);
  if (!QUEUE_ALLOWED_FILES.has(rel) && !isTestFile(file)) {
    for (const i of imports.filter((s) => QUEUE_IMPORTS.test(s))) {
      violations.push(
        `packages/workflows/src/${rel}: imports ${i}; only the transport adapter/worker host may use the queue`,
      );
    }
  }
  if (PURE_FILES.includes(rel)) {
    for (const i of imports.filter((s) => IO_IMPORTS.test(s))) {
      violations.push(`packages/workflows/src/${rel}: pure policy module imports ${i}`);
    }
  }
}

if (violations.length) {
  console.error(`Architecture check failed (${violations.length}):\n  - ${violations.join('\n  - ')}`);
  process.exit(1);
}
console.log(`Architecture check passed (${pkgs.length} packages, layering + imports + runtime boundaries).`);
