import { plugin } from "bun"

/**
 * Vite's asset-query imports, taught to Bun.
 *
 * `session-ui` reaches its Shiki highlighter through `./markdown-shiki.worker.ts?worker&url`,
 * a Vite-only specifier that resolves to the built worker's URL. Bun resolves the query
 * string as part of the path, finds a module with no default export, and throws — which is
 * why `timeline/rows.ts` (and therefore the whole timeline projection) has been unreachable
 * from `bun test`, and why `session-v2-presentation.test.ts` asserts the compaction divider
 * through a hand-copied predicate instead of driving `constructMessageRows` directly.
 *
 * Under test and benchmark there is no worker and no bundler, so the honest stand-in for
 * "the URL of the built worker" is an empty string: `markdown-worker.ts` only ever feeds it
 * to `new Worker(...)`, which nothing in a headless run reaches. Stubbing the URL keeps the
 * import graph loadable without stubbing any behaviour the code under test actually uses.
 */
plugin({
  name: "vite-asset-imports",
  setup(build) {
    build.onResolve({ filter: /\?(worker|url|raw|inline)(&(worker|url|raw|inline))*$/ }, (args) => ({
      path: args.path,
      namespace: "vite-asset",
    }))
    build.onLoad({ filter: /.*/, namespace: "vite-asset" }, () => ({
      contents: `export default ""`,
      loader: "js",
    }))
  },
})
