#!/usr/bin/env bun

import { Script } from "@turenlabs/script"
import { $ } from "bun"

const sha = (await $`git rev-parse HEAD`.text()).trim()
const output = [
  `version=${Script.version}`,
  `tag=v${Script.version}`,
  `sha=${sha}`,
  `repo=${process.env.GH_REPO ?? "turenlabs/turenos"}`,
]

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)
