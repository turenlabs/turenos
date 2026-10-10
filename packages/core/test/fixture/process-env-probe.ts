// Run in a child `bun` started with the secret variables in its environment. Clears them the way the
// named code path does, then reports what a terminal started the way the server starts terminals receives.
import { spawn } from "#pty"
import { Effect, Layer } from "effect"
import { ProcessEnv } from "@turenlabs/core/process-env"
import { SecretVault } from "@turenlabs/core/secret-vault"

if (process.argv[2] === "vault") await Effect.runPromise(Effect.scoped(Layer.build(SecretVault.runtime)))
else ProcessEnv.remove(["PROBE_SECRET"])

const output = await new Promise<string>((resolve) => {
  let output = ""
  const proc = spawn("/usr/bin/env", [], {
    name: "xterm-256color",
    env: Object.fromEntries(
      Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
    ),
  })
  proc.onData((data) => (output += data))
  proc.onExit(() => resolve(output))
})

// The canary proves the terminal ran and its output was read in full, so an empty list cannot come from a missed read.
console.log(
  JSON.stringify({
    pty: output
      .split(/\r?\n/)
      .filter((line) => /^(PROBE_CANARY|PROBE_SECRET|FORGE_SECRET_VAULT_KEY(_ID)?)=/.test(line)),
  }),
)
