import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { Option, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { McpRuntime } from "@/mcp/runtime"
import { isolatedStdioEnvironment } from "@/mcp"
import { Global } from "@turenlabs/core/global"

const digest = `sha256:${"a".repeat(64)}`
const now = Date.now()
const qualified: McpRuntime.DockerQualification = {
  status: "qualified",
  checkedAt: now,
  expiresAt: now + 60_000,
  revision: 1,
  executable: "/usr/local/bin/docker",
  version: "28.0 / daemon 28.0",
  capabilities: ["daemon"],
}

const dockerServer: McpRuntime.DockerServer = {
  backend: "docker",
  image: `registry.example/mcp@${digest}`,
  command: ["mcp-server", "--stdio"],
  secrets: [{ name: "FALCON_CLIENT_SECRET", secret: "FALCON_CLIENT_SECRET" }],
  outboundHosts: [],
}

describe("MCP runtime", () => {
  test("overrides the MCP SDK environment defaults for isolated stdio children", async () => {
    const previous = process.env.FORGE_RUNTIME_SECRET_CANARY
    process.env.FORGE_RUNTIME_SECRET_CANARY = "parent-canary"
    const client = new Client({ name: "isolated-environment-test", version: "1.0.0" })
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts"), "--environment"],
          env: isolatedStdioEnvironment({ MCP_RUNTIME_SECRET: "runtime-secret" }),
          stderr: "pipe",
        }),
      )
      const tool = (await client.listTools()).tools[0]
      expect(tool?.description && JSON.parse(tool.description)).toEqual({
        home: "",
        path: "",
        secret: "runtime-secret",
      })
    } finally {
      await client.close().catch(() => undefined)
      if (previous === undefined) delete process.env.FORGE_RUNTIME_SECRET_CANARY
      else process.env.FORGE_RUNTIME_SECRET_CANARY = previous
    }
  })

  test("qualifies and runs commands in plain Node without Bun or inherited host environment", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forge-mcp-runtime-node-"))
    try {
      const built = await Bun.build({
        entrypoints: [path.join(import.meta.dir, "fixture/runtime-node.ts")],
        target: "node",
        format: "esm",
        outdir: directory,
      })
      expect(built.success).toBe(true)
      const node = Bun.which("node")
      expect(node).toBeDefined()
      const child = Bun.spawn([node!, built.outputs[0]!.path], {
        env: { PATH: "", FORGE_RUNTIME_SECRET_CANARY: "secret-canary" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(JSON.parse(stdout)).toEqual({
        qualification: "unavailable",
        command: {
          exitCode: 0,
          stdout: { bun: "undefined" },
          stderr: "",
        },
      })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  test("validates the persisted backend choice and fails closed when qualification expires", () => {
    const decode = Schema.decodeUnknownOption(McpRuntime.SettingsInput)
    expect(Option.isSome(decode({ backend: "docker" }))).toBe(true)
    expect(Option.isNone(decode({ backend: "qemu" }))).toBe(true)
    expect(McpRuntime.currentDockerQualification({ ...qualified, expiresAt: now - 1 }, now)).toMatchObject({
      status: "unqualified",
    })
    expect(McpRuntime.currentDockerQualification({ ...qualified, expiresAt: undefined }, now)).toMatchObject({
      status: "unqualified",
    })
  })

  test("detects missing Docker and qualifies only daemon-backed hardened launch flags", async () => {
    await expect(McpRuntime.qualifyDocker({ executable: "/missing/docker" })).resolves.toMatchObject({
      status: "unavailable",
    })

    const calls: string[][] = []
    const qualification = await McpRuntime.qualifyDocker({
      executable: process.execPath,
      now: () => 1_000,
      runner: {
        async run(_command, args) {
          calls.push([...args])
          if (args.join(" ").includes(".Client")) return { exitCode: 0, stdout: '{"Version":"28.0"}', stderr: "" }
          if (args.join(" ").includes(".Server")) return { exitCode: 0, stdout: '{"Version":"28.0"}', stderr: "" }
          return {
            exitCode: 0,
            stdout:
              "--network --read-only --cap-drop --security-opt --pids-limit --memory --cpus --user --tmpfs --interactive",
            stderr: "",
          }
        },
      },
    })

    expect(qualification).toMatchObject({
      status: "qualified",
      expiresAt: 1_000 + 24 * 60 * 60_000,
      capabilities: expect.arrayContaining(["network-none", "read-only-rootfs", "non-root"]),
    })
    expect(calls).toEqual([
      ["version", "--format", "{{json .Client}}"],
      ["version", "--format", "{{json .Server}}"],
      ["run", "--help"],
    ])
  })

  test("sanitizes failed Docker diagnostics", async () => {
    const qualification = await McpRuntime.qualifyDocker({
      executable: process.execPath,
      runner: {
        async run() {
          return { exitCode: 1, stdout: "", stderr: "token=top-secret Bearer second-secret" }
        },
      },
    })
    expect(qualification.status).toBe("failed")
    expect(qualification.detail).not.toContain("top-secret")
    expect(qualification.detail).not.toContain("second-secret")
    expect(qualification.detail).toContain("[REDACTED]")
  })

  test("unwraps and sanitizes nested qualification errors", () => {
    const detail = McpRuntime.redactErrorDiagnostic(
      new Error("An error occurred in Effect.tryPromise", {
        cause: new Error("Docker executable could not start: token=runtime-secret"),
      }),
    )
    expect(detail).toBe("Docker executable could not start: token=[REDACTED]")
  })

  test("redacts bound self-hosted secret values from diagnostics and structured logs", () => {
    const value = McpRuntime.redactValue(
      { detail: "FALCON_CLIENT_SECRET=secret-canary", nested: ["Bearer secret-canary"] },
      ["secret-canary"],
    )
    expect(JSON.stringify(value)).not.toContain("secret-canary")
    expect(JSON.stringify(value)).toContain("[REDACTED]")
  })

  test("explains how to recover when the Docker daemon is unavailable", async () => {
    const qualification = await McpRuntime.qualifyDocker({
      executable: process.execPath,
      runner: {
        async run(_command, args) {
          if (args.join(" ").includes(".Client")) return { exitCode: 0, stdout: '{"Version":"28.0"}', stderr: "" }
          return { exitCode: 1, stdout: "", stderr: "Cannot connect to Docker daemon" }
        },
      },
    })
    expect(qualification).toMatchObject({ status: "failed" })
    expect(qualification.detail).toContain("Start Docker Desktop or Docker Engine")
  })

  test("builds a pinned, network-denied Docker launch without command-line secrets", async () => {
    const resolved = await McpRuntime.resolve({
      server: dockerServer,
      settings: McpRuntime.DEFAULT_SETTINGS,
      docker: qualified,
      directory: "/workspace",
      secrets: { FALCON_CLIENT_SECRET: "secret-canary" },
    })
    const command = JSON.stringify(resolved.command)

    expect(command).toContain(`registry.example/mcp@${digest}`)
    expect(command).toContain('"--network","none"')
    expect(command).toContain('"--interactive"')
    expect(command).toContain('"--read-only"')
    expect(command).toContain('"--cap-drop","ALL"')
    expect(command).toContain('"--security-opt","no-new-privileges"')
    expect(command).toContain('"--env","FALCON_CLIENT_SECRET"')
    expect(command).not.toContain("secret-canary")
    expect(command).not.toContain("--volume")
    expect(command).not.toContain("--privileged")
    expect(resolved.environment).toEqual({ FALCON_CLIENT_SECRET: "secret-canary" })
    expect(resolved.containerName).toStartWith("turen-mcp-")
  })

  test("refuses non-pinned images, unsupported egress, shell snippets, and unqualified selections", async () => {
    await expect(
      McpRuntime.resolve({
        server: { ...dockerServer, image: "registry.example/mcp:latest" },
        settings: McpRuntime.DEFAULT_SETTINGS,
        docker: qualified,
        directory: "/workspace",
        secrets: { FALCON_CLIENT_SECRET: "secret" },
      }),
    ).rejects.toThrow("pinned")
    await expect(
      McpRuntime.resolve({
        server: { ...dockerServer, outboundHosts: ["api.example.com"] },
        settings: McpRuntime.DEFAULT_SETTINGS,
        docker: qualified,
        directory: "/workspace",
        secrets: { FALCON_CLIENT_SECRET: "secret" },
      }),
    ).rejects.toThrow("allowlisting")
    await expect(
      McpRuntime.resolve({
        server: { ...dockerServer, command: ["python", "-c", "print('unsafe')"] },
        settings: McpRuntime.DEFAULT_SETTINGS,
        docker: qualified,
        directory: "/workspace",
        secrets: { FALCON_CLIENT_SECRET: "secret" },
      }),
    ).rejects.toThrow("unsafe")
    await expect(
      McpRuntime.resolve({
        server: dockerServer,
        settings: McpRuntime.DEFAULT_SETTINGS,
        docker: { ...qualified, status: "unqualified" },
        directory: "/workspace",
        secrets: { FALCON_CLIENT_SECRET: "secret" },
      }),
    ).rejects.toThrow("not qualified")
  })

  test("requires explicit local opt-in and rejects shell executables", async () => {
    const server: McpRuntime.LocalServer = {
      backend: "local",
      executable: "/bin/sh",
      args: ["-c", "echo unsafe"],
      secrets: [],
    }
    await expect(
      McpRuntime.resolve({
        server,
        settings: { version: 1, backend: "local", localProcess: { enabled: false } },
        docker: qualified,
        directory: "/workspace",
        secrets: {},
      }),
    ).rejects.toThrow("disabled")
    await expect(
      McpRuntime.resolve({
        server,
        settings: { version: 1, backend: "local", localProcess: { enabled: true } },
        docker: qualified,
        directory: "/workspace",
        secrets: {},
      }),
    ).rejects.toThrow("safe absolute executable")
    await expect(
      McpRuntime.resolve({
        server: { backend: "local", executable: "/usr/bin/python3", args: ["/tmp/server.py"], secrets: [] },
        settings: { version: 1, backend: "local", localProcess: { enabled: true } },
        docker: qualified,
        directory: "/workspace",
        secrets: {},
      }),
    ).rejects.toThrow("safe absolute executable")
    const python = await McpRuntime.resolve({
      server: { backend: "local", executable: "/usr/bin/python3", args: ["-m", "site"], secrets: [] },
      settings: { version: 1, backend: "local", localProcess: { enabled: true } },
      docker: qualified,
      directory: "/workspace",
      secrets: {},
    })
    expect(python.command.slice(1, 4)).toEqual(["-I", "-m", "site"])
  })

  test("runs audited package recipes from the managed binary root with an isolated environment", async () => {
    const executable = "/usr/bin/true"
    const resolved = await McpRuntime.resolve({
      server: {
        backend: "package",
        executable,
        args: ["tool", "run"],
        environment: { READ_ONLY: "true" },
        secrets: [{ name: "API_KEY", secret: "API_KEY" }],
      },
      settings: McpRuntime.DEFAULT_SETTINGS,
      docker: qualified,
      directory: "/workspace",
      secrets: { API_KEY: "secret" },
    })
    expect(resolved.command).toEqual([executable, "tool", "run"])
    expect(resolved.environment).toEqual({ READ_ONLY: "true", API_KEY: "secret" })
    expect(McpRuntime.trustedLocalExecutablePath(path.join(Global.Path.bin, "uv-0.12.6"))).toBe(true)
  })

  test("closes tracked self-hosted runtimes when backend selection changes", async () => {
    let closes = 0
    const generation = McpRuntime.currentGeneration()
    const unregister = McpRuntime.registerConnection(generation, async () => {
      closes += 1
    })
    if (!unregister) throw new Error("Current runtime generation was rejected")
    expect(await McpRuntime.invalidateActiveConnections()).toBe(1)
    expect(closes).toBe(1)
    unregister()
  })

  test("fences a launch that carries a generation captured before a backend change", async () => {
    const stale = McpRuntime.currentGeneration()
    await McpRuntime.invalidateActiveConnections()
    expect(McpRuntime.registerConnection(stale, async () => undefined)).toBeUndefined()
  })

  test("destroys Docker containers by generated name without a shell", async () => {
    const commands: string[][] = []
    await McpRuntime.destroyContainer(
      { executable: "/usr/local/bin/docker", name: "turen-mcp-test" },
      {
        async run(_command, args) {
          commands.push([...args])
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      },
    )
    expect(commands).toEqual([["rm", "--force", "turen-mcp-test"]])
  })

  test("reconciles only containers that match the runtime label and valid Docker IDs", async () => {
    const commands: string[][] = []
    const removed = await McpRuntime.reconcileDocker(qualified, {
      async run(_command, args) {
        commands.push([...args])
        if (args[0] === "ps") return { exitCode: 0, stdout: "abcdef012345\n../../not-a-container\n", stderr: "" }
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    })
    expect(removed).toEqual(["abcdef012345"])
    expect(commands).toEqual([
      ["ps", "--all", "--filter", "label=io.turenlabs.mcp-runtime=1", "--format", "{{.ID}}"],
      ["rm", "--force", "abcdef012345"],
    ])
  })
})
