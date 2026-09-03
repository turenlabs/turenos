import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { httpClient } from "@turenlabs/core/effect/app-node-platform"
import { Effect, Layer, Schema, Context, Stream } from "effect"
import { serviceUse } from "@turenlabs/core/effect/service-use"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@turenlabs/core/process"
import path from "path"
import { makeRuntime } from "@turenlabs/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@turenlabs/core/installation/version"
import { InstallationEvent } from "@turenlabs/schema/installation-event"

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = InstallationEvent

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `forge/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "prod"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

// Response schemas for external version APIs
const GitHubRelease = Schema.Struct({ tag_name: Schema.String })

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@forge/Installation") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const upgradeFailure = (method: Method, result?: { code: number; stdout: string; stderr: string }) => {
      if (result) return `Upgrade failed for ${method} (exit code ${result.code}).`
      return `Upgrade failed for ${method}.`
    }

    const upgradeScriptShell = Effect.fnUntraced(function* () {
      const bashVersion = yield* text(["bash", "--version"])
      if (bashVersion) return "bash"
      return "sh"
    })

    const upgradeCurl = Effect.fnUntraced(
      function* (target: string) {
        const body = yield* text([
          "gh",
          "api",
          "-H",
          "Accept: application/vnd.github.raw+json",
          "repos/turenlabs/forge/contents/install",
        ])
        if (!body) {
          return yield* new UpgradeFailedError({
            stderr: "TurenOS updates require an authenticated GitHub CLI. Run `gh auth login` and try again.",
          })
        }
        const bodyBytes = new TextEncoder().encode(body)
        const shell = yield* upgradeScriptShell()
        const result = yield* appProcess.run(
          ChildProcess.make(shell, [], {
            stdin: Stream.make(bodyBytes),
            env: { VERSION: target },
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.mapError(() => new UpgradeFailedError({ stderr: upgradeFailure("curl") })),
    )

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        if (process.execPath.includes(path.join(".forge", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        return "unknown" as Method
      }),
      latest: Effect.fn("Installation.latest")(function* (_installMethod?: Method) {
        const ghTag = yield* text([
          "gh",
          "release",
          "view",
          "--repo",
          "turenlabs/forge",
          "--json",
          "tagName",
          "--jq",
          ".tagName",
        ])
        if (ghTag.trim()) return ghTag.trim().replace(/^v/, "")

        const response = yield* httpOk.execute(
          HttpClientRequest.get("https://api.github.com/repos/turenlabs/forge/releases/latest").pipe(
            HttpClientRequest.acceptJson,
          ),
        )
        const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
        return data.tag_name.replace(/^v/, "")
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        if (m !== "curl") return yield* new UpgradeFailedError({ stderr: `Unknown installation method: ${m}` })
        const upgradeResult = yield* upgradeCurl(target)
        if (!upgradeResult || upgradeResult.code !== 0) {
          return yield* new UpgradeFailedError({ stderr: upgradeFailure(m, upgradeResult) })
        }
        yield* Effect.logInfo("upgraded", {
          method: m,
          target,
          stdout: upgradeResult.stdout,
          stderr: upgradeResult.stderr,
        })
        yield* text([process.execPath, "--version"])
      }),
    }

    return Service.of(result)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [httpClient, AppProcess.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
