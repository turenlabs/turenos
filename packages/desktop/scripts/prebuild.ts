#!/usr/bin/env bun
import { $ } from "bun"

import { copyBinaryToSidecarFolder, getCurrentSidecar, resolveChannel, windowsify } from "./utils"

const channel = resolveChannel()
await $`bun ../../script/license-audit.ts --write`
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

const binary = getCurrentSidecar().ocBinary
const flags = ["--single", ...(binary.endsWith("-baseline") ? ["--baseline"] : []), "--skip-install"]
await $`cd ../forge && bun script/build.ts ${flags}`
await copyBinaryToSidecarFolder(windowsify(`../forge/dist/${binary}/bin/forge`))
await $`cd ../forge && bun script/build-node.ts`
