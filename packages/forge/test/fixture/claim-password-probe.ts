// Run in a child `bun` started with FORGE_SERVER_PASSWORD in its environment. Claims the password,
// then reports whether a PTY child still receives it.
import { spawn } from "@turenlabs/core/pty/pty.bun"
import { ServerAuth } from "../../src/server/auth"

ServerAuth.claimPassword()

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

console.log(JSON.stringify({ pty: output.split(/\r?\n/).filter((line) => line.startsWith("FORGE_SERVER_PASSWORD=")) }))
