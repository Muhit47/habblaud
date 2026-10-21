// Bundles server (TypeScript) into single ESM file in dist/server and writes dist/build.json (commit and "dirty
// copy", see scripts/build-info.mjs).
import { build } from 'esbuild';
import { writeBuildInfo } from './build-info.mjs';

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});

const info = writeBuildInfo('dist/build.json');
console.log(`  dist/build.json  ${info.commit === 'unknown' ? 'unknown' : info.commit.slice(0, 12)}${info.dirty ? ' (dirty)' : ''}`);
