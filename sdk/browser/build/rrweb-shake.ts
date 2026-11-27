import { readFile } from 'node:fs/promises';
import type { Plugin } from 'esbuild';

/**
 * rrweb's single-file dist evaluates two bundled copies of postcss at module scope (replayer only),
 * which stops tree shaking and adds ~110 KB to a record-only bundle. Wrapping those statements in
 * pure IIFEs lets esbuild drop them. The patterns are checked so an rrweb upgrade cannot silently skip this.
 */
export function rrwebShake(): Plugin {
  const rewrites: Array<[RegExp, string, number]> = [
    [/^(var import_postcss(?:\$1)? = \/\* @__PURE__ \*\/ )(__toESM(?:\$1)?\(\()/gm, '$1(() => $2', 2],
    [/^\}\)\)\)\(\), 1\);$/gm, '})))(), 1))();', 2],
    [/^import_postcss(?:\$1)?\.default(?:\.\w+)?;$/gm, '', 49],
    [/^var postcss_default = import_postcss\$1\.default;$/m, 'var postcss_default = /* @__PURE__ */ (() => import_postcss$1.default)();', 1],
  ];
  return {
    name: 'rrweb-shake',
    setup(build) {
      build.onLoad({ filter: /rrweb[\\/]dist[\\/]rrweb\.js$/ }, async ({ path }) => {
        let contents = await readFile(path, 'utf8');
        for (const [pattern, replacement, expected] of rewrites) {
          const found = contents.match(pattern)?.length ?? 0;
          if (found !== expected) {
            throw new Error(`rrweb-shake: expected ${expected} matches of ${pattern}, found ${found}`);
          }
          contents = contents.replace(pattern, replacement);
        }
        return { contents, loader: 'js' };
      });
    },
  };
}
