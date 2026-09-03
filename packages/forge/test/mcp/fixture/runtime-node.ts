import { McpRuntime } from "@/mcp/runtime"

const qualification = await McpRuntime.qualifyDocker()
const command = await McpRuntime.commandRunner.run(
  process.execPath,
  [
    "-e",
    "process.stdout.write(JSON.stringify({ bun: typeof globalThis.Bun, path: process.env.PATH, home: process.env.HOME, canary: process.env.FORGE_RUNTIME_SECRET_CANARY }))",
  ],
  5_000,
)

process.stdout.write(
  JSON.stringify({
    qualification: qualification.status,
    command: {
      exitCode: command.exitCode,
      stdout: JSON.parse(command.stdout),
      stderr: command.stderr,
    },
  }),
)
