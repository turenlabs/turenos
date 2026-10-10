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
  const proc = spawn("/bin/sh", ["-c", "/usr/bin/env; printf '\\nPROBE_COMPLETE\\n'; read _"], {
    name: "xterm-256color",
    env: Object.fromEntries(
      Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
    ),
  })
  proc.onData((data) => {
    const complete = output.includes("\nPROBE_COMPLETE")
    output += data
    if (!complete && output.includes("\nPROBE_COMPLETE")) proc.write("\n")
  })
  proc.onExit(() => resolve(output))
})

// The child waits until its complete environment is read before exiting.
console.log(
  JSON.stringify({
    pty: output
      .split(/[\r\n]+/)
      .filter((line) => /^(PROBE_CANARY|PROBE_SECRET|FORGE_SECRET_VAULT_KEY(_ID)?)=/.test(line)),
  }),
)
