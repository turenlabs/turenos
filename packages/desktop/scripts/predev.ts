#!/usr/bin/env bun
import { $ } from "bun"

await $`bun ./scripts/stage-bun.ts`
await $`bun ./scripts/copy-icons.ts ${process.env.FORGE_CHANNEL ?? "dev"}`
await $`cd ../forge && bun script/build-node.ts`
await $`bun ./scripts/build-sidecar.ts`
