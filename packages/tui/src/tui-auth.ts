import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { promisify } from "node:util"

export class CliError extends Error {
  readonly _tag = "CliError"

  constructor(input: { message: string }) {
    super(input.message)
    this.name = "CliError"
  }
}

type LocalService = {
  platform: NodeJS.Platform
  uid: number | undefined
  mainPID: () => Promise<string>
}

export async function resolveTuiAuth(
  input: { url: URL; username?: string; discoverAuth?: boolean; env: NodeJS.ProcessEnv },
  service: LocalService = {
    platform: process.platform,
    uid: process.getuid?.(),
    mainPID: async () => {
      const result = await promisify(execFile)(
        "systemctl",
        ["show", "--property=MainPID", "--value", "turenos.service"],
        {
          timeout: 3_000,
          killSignal: "SIGKILL",
          maxBuffer: 1_024,
          encoding: "utf8",
        },
      )
      return result.stdout
    },
  },
) {
  const configured = {
    username: input.username ?? input.env.FORGE_SERVER_USERNAME ?? "forge",
    password: input.env.FORGE_SERVER_PASSWORD,
  }
  // These numeric loopback hosts avoid DNS and match the adapter's proxy bypass.
  const loopback = input.url.hostname === "127.0.0.1" || input.url.hostname === "[::1]"
  if (configured.password && input.url.protocol !== "https:" && !(input.url.protocol === "http:" && loopback)) {
    throw new CliError({
      message: "Server credentials require HTTPS, or HTTP on 127.0.0.1 or [::1] for an SSH tunnel.",
    })
  }
  // An explicitly set password, including an empty one, opts out of discovery.
  // Process ownership does not prove listener ownership; discovery requires trust.
  if (
    !input.discoverAuth ||
    configured.password !== undefined ||
    input.url.href !== "http://127.0.0.1:4096/" ||
    service.platform !== "linux" ||
    service.uid === undefined
  ) {
    return configured
  }

  const inherited = await localCredentials(service).catch(() => undefined)
  return {
    username: input.username ?? input.env.FORGE_SERVER_USERNAME ?? inherited?.username ?? "forge",
    password: inherited?.password,
  }
}

async function localCredentials(service: LocalService) {
  const pid = (await service.mainPID()).trim()
  if (!/^[1-9]\d*$/.test(pid) || !Number.isSafeInteger(Number(pid))) return undefined
  const environment = await fs.open(`/proc/${pid}/environ`, "r")
  try {
    // Check the opened file before reading so another user's process is never
    // a credential source, even when this CLI has permission to inspect it.
    if ((await environment.stat()).uid !== service.uid) return undefined
    const entries = (await environment.readFile()).toString("utf8").split("\0")
    return {
      username: entries
        .find((entry) => entry.startsWith("FORGE_SERVER_USERNAME="))
        ?.slice("FORGE_SERVER_USERNAME=".length),
      password: entries
        .find((entry) => entry.startsWith("FORGE_SERVER_PASSWORD="))
        ?.slice("FORGE_SERVER_PASSWORD=".length),
    }
  } finally {
    await environment.close()
  }
}
