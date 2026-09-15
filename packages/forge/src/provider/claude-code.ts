import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { ClaudeCodeCLI } from "@turenlabs/core/provider/claude-code"
import { which as findExecutable } from "@turenlabs/core/util/which"
import type { ModelsDev } from "@turenlabs/core/models-dev"
import { spawnSync } from "node:child_process"
import type { Info, Model } from "./provider"

export const ID = ProviderV2.ID.make("claude-code")
export const DEFAULT_EXECUTABLE = "claude"

const OUTPUT_LIMIT = 64 * 1024
const PROBE_TIMEOUT = 5_000

type ProbeProcess = {
  readonly exited: Promise<number>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly kill: (signal?: number) => void
}

type Spawn = (options: {
  readonly cmd: string[]
  readonly env: Record<string, string | undefined>
  readonly stdin: "ignore"
  readonly stdout: "pipe"
  readonly stderr: "pipe"
}) => ProbeProcess

export type ProbeResult =
  | { readonly status: "authenticated"; readonly executable: string }
  | { readonly status: "unauthenticated"; readonly executable: string }
  | { readonly status: "unavailable" }

export function subscriptionEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env = Object.fromEntries(
    Object.entries(source).filter(
      ([name]) =>
        !name.startsWith("ANTHROPIC_") &&
        !name.startsWith("CLAUDE_CODE_USE_") &&
        name !== "CLAUDE_CODE_API_BASE_URL" &&
        name !== "CLAUDE_CODE_OAUTH_TOKEN",
    ),
  )
  const noProxy = [
    ...(env.NO_PROXY ?? "").split(","),
    ...(env.no_proxy ?? "").split(","),
    "localhost",
    "127.0.0.1",
    "::1",
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "forge"
  env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "forge"
  env.NO_PROXY = [...new Set(noProxy)].join(",")
  env.no_proxy = env.NO_PROXY
  return env
}

function model(
  id: string,
  name: string,
  family: string,
  limits: {
    readonly apiID?: string
    readonly context?: number
    readonly output?: number
    readonly efforts?: ReadonlyArray<string>
    readonly releaseDate?: string
  } = {},
): Model {
  return {
    id: ModelV2.ID.make(id),
    providerID: ID,
    api: {
      id: limits.apiID ?? id,
      npm: "claude-code-cli",
      url: "local://claude-code",
    },
    name,
    family,
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: true,
    },
    // Claude Code uses the user's existing Claude subscription. API-token
    // pricing would be misleading in TurenOS's cost display.
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: limits.context ?? 200_000, output: limits.output ?? 64_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: limits.releaseDate ?? "",
    // The composer renders its effort selector from this snapshot, so the ids
    // here must be exactly the ones the v2 catalog publishes — a level offered
    // here but absent there would fall back to the model default at run time.
    variants: Object.fromEntries((limits.efforts ?? []).map((effort) => [effort, { effort }])),
  }
}

/**
 * @param catalog models.dev entries, used to resolve each CLI alias's real
 * window from the anthropic models it actually serves. Omitted only where no
 * catalog is reachable, in which case the static table's fallbacks apply.
 */
export function info(catalog?: Record<string, ModelsDev.Provider>): Info {
  const entries = Object.entries(catalog?.[ClaudeCodeCLI.CATALOG_PROVIDER]?.models ?? {}).map(([id, model]) => ({
    id,
    name: model.name,
    family: model.family,
    released: Date.parse(model.release_date ?? "") || 0,
    limit: { context: model.limit.context, output: model.limit.output },
    status: model.status,
  }))
  const byFamily = ClaudeCodeCLI.windowsByFamily(entries)
  return {
    id: ID,
    name: "Claude Code (local)",
    source: "custom",
    env: [],
    options: {},
    models: Object.fromEntries([
      ...ClaudeCodeCLI.MODELS.map((item) => {
        const window = ClaudeCodeCLI.windowFor(item, byFamily)
        return [
          item.id,
          model(item.id, item.name, item.family, {
            apiID: item.apiID,
            context: window.context,
            output: window.output,
            efforts: item.efforts,
          }),
        ] as const
      }),
      // Fixed-generation entries next to the floating aliases, so a specific
      // release stays selectable — and individually hideable — after the alias
      // moves on to a newer one.
      ...ClaudeCodeCLI.pinnedModels(entries).map(
        (pinned) =>
          [
            pinned.id,
            model(pinned.id, pinned.name, pinned.family, {
              apiID: pinned.apiID,
              context: pinned.context,
              output: pinned.output,
              efforts: pinned.efforts,
              releaseDate: pinned.released ? new Date(pinned.released).toISOString().slice(0, 10) : "",
            }),
          ] as const,
      ),
    ]),
  }
}

function resolveExecutable(value: unknown, which: (command: string) => string | null): string | undefined {
  const requested = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_EXECUTABLE
  return which(requested) ?? undefined
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let output = ""
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) throw new Error("Claude Code probe output exceeded its limit")
      output += decoder.decode(next.value, { stream: true })
    }
    return output + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export async function probe(
  value?: unknown,
  spawn?: Spawn,
  which: (command: string) => string | null = findExecutable,
): Promise<ProbeResult> {
  const executable = resolveExecutable(value, which)
  if (!executable) return { status: "unavailable" }

  if (!spawn) {
    try {
      const result = spawnSync(executable, ["auth", "status", "--json"], {
        env: subscriptionEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: PROBE_TIMEOUT,
        killSignal: "SIGKILL",
        maxBuffer: OUTPUT_LIMIT,
        windowsHide: true,
      })
      if (result.error) return { status: "unavailable" }
      if (result.status !== 0) return { status: "unauthenticated", executable }
      const status = JSON.parse(result.stdout) as { loggedIn?: unknown }
      return status.loggedIn === true
        ? { status: "authenticated", executable }
        : { status: "unauthenticated", executable }
    } catch {
      return { status: "unavailable" }
    }
  }

  let proc: ProbeProcess | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    proc = spawn({
      cmd: [executable, "auth", "status", "--json"],
      env: subscriptionEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        proc?.kill(9)
        reject(new Error("Claude Code probe timed out"))
      }, PROBE_TIMEOUT)
    })
    const [code, stdout] = await Promise.race([
      Promise.all([proc.exited, readBounded(proc.stdout, OUTPUT_LIMIT), readBounded(proc.stderr, OUTPUT_LIMIT)]).then(
        ([exit, out]) => [exit, out] as const,
      ),
      timeout,
    ])
    if (code !== 0) return { status: "unauthenticated", executable }
    const result = JSON.parse(stdout) as { loggedIn?: unknown }
    return result.loggedIn === true
      ? { status: "authenticated", executable }
      : { status: "unauthenticated", executable }
  } catch {
    proc?.kill(9)
    return { status: "unavailable" }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export * as ClaudeCodeProvider from "./claude-code"
