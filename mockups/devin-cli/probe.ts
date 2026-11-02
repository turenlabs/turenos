import { execFileSync } from "node:child_process"

// This probe sends initialize only. It does not authenticate, create a session, or send a prompt.
const executable = process.argv[2] ?? "devin"
const version = execFileSync(executable, ["--version"], {
  encoding: "utf8",
  timeout: 10_000,
  stdio: ["ignore", "pipe", "ignore"],
}).trim()
const child = Bun.spawn([executable, "acp"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "ignore",
})
const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000)
const decoder = new TextDecoder()
let buffer = ""
let bytes = 0
let result: Record<string, unknown> | undefined

try {
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "turenos-research", version: "0.0.0" },
      },
    }) + "\n",
  )
  await child.stdin.flush()

  for await (const chunk of child.stdout) {
    bytes += chunk.byteLength
    if (bytes > 1024 * 1024) throw new Error("Initialize output exceeded 1 MiB")
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""

    for (const line of lines.filter((value) => value.trim())) {
      const response: unknown = JSON.parse(line)
      if (typeof response !== "object" || response === null || !("id" in response) || response.id !== 1) continue
      if (!("result" in response) || typeof response.result !== "object" || response.result === null)
        throw new Error("Devin rejected initialize")
      result = response.result as Record<string, unknown>
      break
    }
    if (result) break
  }

  if (!result) throw new Error("Devin returned no initialize response within 15 seconds")
  if (result.protocolVersion !== 1) throw new Error("Devin did not negotiate ACP version 1")

  console.log(
    JSON.stringify(
      {
        executableVersion: version,
        protocolVersion: result.protocolVersion,
        agentInfo: result.agentInfo,
        agentCapabilities: result.agentCapabilities,
        authMethods: Array.isArray(result.authMethods)
          ? result.authMethods.flatMap((method: unknown) =>
              typeof method === "object" && method !== null && "id" in method && "name" in method
                ? [{ id: method.id, name: method.name }]
                : [],
            )
          : [],
      },
      null,
      2,
    ),
  )
} finally {
  child.stdin.end()
  child.kill("SIGTERM")
  await child.exited
  clearTimeout(deadline)
}
