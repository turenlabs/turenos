import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.FORGE_CHANNEL ?? "dev"}`

await $`cd ../forge && bun script/build-node.ts`
