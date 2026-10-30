import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Purity guard for the reconciliation policy: the modules in `reconciliation/` and every module
 * they import (transitively, within the package) perform no I/O — no persistence, queue,
 * storage, network, AI, workflow runtime or Node I/O imports — and read no clock or randomness.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const FORBIDDEN_IMPORT =
  /^(mongodb|bullmq|ioredis|node:(fs|net|http|https|child_process|worker_threads|dgram|dns|tls)|fs|net|http|https|@aptamind\/(db|queue|storage|net|ai|observability|workflow-sdk|workflows|workflow-nodes|testing|config))(\/|$)/;
const ALLOWED_PACKAGES = /^(zod|@aptamind\/(contracts|provenance|taxonomy))(\/|$)/;
// Clock, randomness, process, timers, network and crypto are all impure: `Date.now()`, `new Date()`,
// a bare `Date(...)` call, `performance.now()`, `Math.random()`, `crypto.`, `fetch(`.
const IMPURE_CALLS_EXTRA = /(?<!new\s)(?<![\w.])Date\s*\(|\bperformance\.now\s*\(|\bcrypto\.|\bfetch\s*\(/;
const IMPURE_CALLS =
  /\bDate\.now\s*\(|new Date\(\s*\)|Math\.random\s*\(|\bprocess\.(env|exit|argv|hrtime|nextTick)\b|setTimeout\s*\(|setInterval\s*\(/;

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  // `import … from 'x'`, `export … from 'x'`, side-effect `import 'x'`, dynamic `import('x')`, `require('x')`.
  const re =
    /(?:import|export)\s[^'";]*?from\s+['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;
  return [...src.matchAll(re)].map((m) => (m[1] ?? m[2] ?? m[3]) as string);
}

function resolve(from: string, spec: string): string {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`cannot resolve ${spec} from ${from}`);
}

describe('reconciliation policy purity', () => {
  const roots = readdirSync(here)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(here, f));

  it('has policy modules to check', () => {
    expect(roots.map((f) => path.basename(f))).toEqual(
      expect.arrayContaining(['policy.ts', 'compatibility.ts', 'requests.ts', 'confidence.ts']),
    );
  });

  it('imports nothing that performs I/O, transitively', () => {
    const seen = new Set<string>();
    const violations: string[] = [];
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const rel = path.relative(here, file);
      const src = readFileSync(file, 'utf8');
      if (IMPURE_CALLS.test(src) || IMPURE_CALLS_EXTRA.test(src))
        violations.push(`${rel}: clock, randomness or process access`);
      for (const spec of importsOf(file)) {
        if (spec.startsWith('.')) visit(resolve(file, spec));
        else if (FORBIDDEN_IMPORT.test(spec) || !ALLOWED_PACKAGES.test(spec))
          violations.push(`${rel}: imports ${spec}`);
      }
    };
    roots.forEach(visit);
    expect(seen.size).toBeGreaterThan(roots.length);
    expect(violations).toEqual([]);
  });
});
