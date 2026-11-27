import { defineConfig } from 'tsup';
import { rrwebShake } from './build/rrweb-shake';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2020',
  },
  {
    entry: { kimmi: 'src/script.ts' },
    format: ['iife'],
    minify: true,
    target: 'es2019',
    platform: 'browser',
    noExternal: [/.*/],
    outExtension: () => ({ js: '.js' }),
    esbuildPlugins: [rrwebShake()],
  },
]);
