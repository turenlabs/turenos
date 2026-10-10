import { afterEach } from "bun:test"

/** What tests opened (fake servers, renderers, dashboards, aborts), released after every test in every file. */
export const cleanup: (() => unknown)[] = []

// Loaded by bunfig.toml as a preload: a hook here applies to every test file, while one registered by an imported
// helper reaches only the first file that loads it.
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
