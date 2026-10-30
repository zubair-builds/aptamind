import { defineConfig } from 'tsup';

// Workspace packages ship TypeScript sources and are bundled; every third-party runtime
// dependency is declared in this app's package.json and therefore stays external
// (resolved from node_modules at runtime — required for native/optional modules and Playwright).
export default defineConfig({
  entry: ['src/main.ts', 'src/migrate.ts', 'src/seed.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@aptamind\//],
  splitting: false,
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
