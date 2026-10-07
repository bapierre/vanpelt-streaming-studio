import { build } from 'esbuild';

export function bundle(entry, outfile) {
  return build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // CommonJS dependencies need require; ws treats its native accelerators as optional.
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    external: ['bufferutil', 'utf-8-validate'],
  });
}
