#!/usr/bin/env bun
import path from "node:path"
import { resolveChannel } from "./utils"

const result = await Bun.build({
  entrypoints: [path.resolve(import.meta.dir, "../src/main/sidecar.ts")],
  outdir: path.resolve(import.meta.dir, "../../forge/dist/node"),
  target: "bun",
  define: { "import.meta.env.FORGE_CHANNEL": JSON.stringify(resolveChannel()) },
  plugins: [
    {
      name: "backend-entry",
      setup(builder) {
        builder.onResolve({ filter: /^virtual:forge-server$/ }, () => ({ path: "./node.js", external: true }))
      },
    },
  ],
})
if (!result.success) throw new AggregateError(result.logs, "Bun sidecar build failed")
