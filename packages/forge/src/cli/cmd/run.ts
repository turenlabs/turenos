import type { PermissionV1 } from "@turenlabs/core/v1/permission"
import { FSUtil } from "@turenlabs/core/fs-util"
// Headless CLI entry point for `forge run`.
//
// Sends one prompt or slash command, streams events to stdout, and exits when
// the Session becomes idle. `--attach` targets an existing TurenOS server while
// the default path uses the in-process server.
import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { open } from "node:fs/promises"
import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { EOL } from "os"
import { Filesystem } from "@/util/filesystem"
import { createForgeClient, type ForgeClient, type ToolPart } from "@turenlabs/sdk/v2"
import { FormatError, FormatUnknownError } from "../error"

type ModelInput = Parameters<ForgeClient["session"]["prompt"]>[0]["model"]

function pick(value: string | undefined): ModelInput | undefined {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  return {
    providerID,
    modelID: rest.join("/"),
  } as ModelInput
}

function resolveRunInput(value?: string, piped?: string): string | undefined {
  if (!value) {
    return piped
  }

  if (!piped) {
    return value
  }

  return value + "\n" + piped
}

type FilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

const ATTACH_FILE_MAX_BYTES = 10 * 1024 * 1024

type Inline = {
  icon: string
  title: string
  description?: string
}

type SessionInfo = {
  id: string
  title?: string
  directory?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function formatRunError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

async function tool(part: ToolPart) {
  inline({
    icon: "\u2699",
    title: part.tool,
  })
}

async function toolError(part: ToolPart) {
  inline({
    icon: "✗",
    title: `${part.tool} failed`,
  })
}

export const RunCommand = effectCmd({
  command: "run [message..]",
  describe: "run forge with a message",
  // --attach connects to a remote server (no local instance needed); the
  // default path runs an in-process server and needs the project instance.
  instance: (args) => !args.attach,
  // For --dir without --attach, load instance for the resolved target dir.
  // The handler also chdirs (preserving the legacy order: chdir → file resolution).
  directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running forge server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to FORGE_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to FORGE_SERVER_USERNAME or 'forge')",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
      }),
  handler: Effect.fn("Cli.run")(function* (args) {
    const { Agent } = yield* Effect.promise(() => import("@/agent/agent"))
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const agentSvc = yield* Agent.Service
    const localInstance = yield* InstanceRef
    yield* Effect.promise(async () => {
      const thinking = args.thinking ?? false

      let message = [...args.message, ...(args["--"] || [])]
        .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
        .join(" ")

      const root = Filesystem.resolve(process.env.PWD ?? process.cwd())
      const directory = (() => {
        if (!args.dir) return args.attach ? undefined : root
        if (args.attach) return args.dir

        try {
          process.chdir(path.isAbsolute(args.dir) ? args.dir : path.join(root, args.dir))
          return process.cwd()
        } catch {
          UI.error("Failed to change directory to " + args.dir)
          process.exit(1)
        }
      })()
      const attachHeaders = args.attach
        ? ServerAuth.headers({ password: args.password, username: args.username })
        : undefined
      const attachSDK = (dir?: string) => {
        return createForgeClient({
          baseUrl: args.attach!,
          directory: dir,
          headers: attachHeaders,
        })
      }

      const files: FilePart[] = []
      if (args.file) {
        const list = Array.isArray(args.file) ? args.file : [args.file]

        for (const filePath of list) {
          const resolvedPath = path.resolve(args.attach ? root : (directory ?? root), filePath)
          if (!(await Filesystem.exists(resolvedPath))) {
            UI.error(`File not found: ${filePath}`)
            process.exit(1)
          }

          const stat = Filesystem.stat(resolvedPath)
          const isDirectory = stat?.isDirectory() ?? false
          if (args.attach && isDirectory) {
            UI.error(`Cannot attach local directory without a shared filesystem: ${filePath}`)
            process.exit(1)
          }

          const content = await (async () => {
            if (!args.attach) return
            const handle = await open(resolvedPath, "r")
            try {
              const opened = await handle.stat()
              if (!opened.isFile() || Number(opened.size) > ATTACH_FILE_MAX_BYTES) {
                UI.error(`Cannot attach local file larger than 10 MiB or a special file: ${filePath}`)
                process.exit(1)
              }
              if (opened.size === 0) return Buffer.alloc(0)
              const buffer = Buffer.alloc(Number(opened.size))
              let offset = 0
              while (offset < buffer.length) {
                const read = await handle.read(buffer, offset, buffer.length - offset, offset)
                if (read.bytesRead === 0) break
                offset += read.bytesRead
              }
              return buffer.subarray(0, offset)
            } finally {
              await handle.close()
            }
          })()
          const detected = FSUtil.mimeType(resolvedPath)
          const text = content?.toString("utf8")
          const mime = !args.attach
            ? isDirectory
              ? "application/x-directory"
              : "text/plain"
            : content && text !== undefined && Buffer.from(text, "utf8").equals(content)
              ? "text/plain"
              : detected

          files.push({
            type: "file",
            url: content ? `data:${mime};base64,${content.toString("base64")}` : pathToFileURL(resolvedPath).href,
            filename: path.basename(resolvedPath),
            mime,
          })
        }
      }

      const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
      message = resolveRunInput(message, piped) ?? ""

      if (message.trim().length === 0 && !args.command) {
        UI.error("You must provide a message or a command")
        process.exit(1)
      }

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exit(1)
      }

      const rules: PermissionV1.Ruleset = [
        {
          permission: "question",
          action: "deny",
          pattern: "*",
        },
        {
          permission: "plan_enter",
          action: "deny",
          pattern: "*",
        },
        {
          permission: "plan_exit",
          action: "deny",
          pattern: "*",
        },
      ]

      function title() {
        if (args.title === undefined) return
        if (args.title !== "") return args.title
        return message.slice(0, 50) + (message.length > 50 ? "..." : "")
      }

      async function session(sdk: ForgeClient): Promise<SessionInfo | undefined> {
        if (args.session) {
          const current = await sdk.session
            .get({
              sessionID: args.session,
            })
            .catch(() => undefined)

          if (!current?.data) {
            UI.error("Session not found")
            process.exit(1)
          }

          if (args.fork) {
            const forked = await sdk.session.fork({
              sessionID: args.session,
            })
            const id = forked.data?.id
            if (!id) {
              return
            }

            return {
              id,
              title: forked.data?.title ?? current.data.title,
              directory: forked.data?.directory ?? current.data.directory,
            }
          }

          return {
            id: current.data.id,
            title: current.data.title,
            directory: current.data.directory,
          }
        }

        const base = args.continue ? (await sdk.session.list()).data?.find((item) => !item.parentID) : undefined

        if (base && args.fork) {
          const forked = await sdk.session.fork({
            sessionID: base.id,
          })
          const id = forked.data?.id
          if (!id) {
            return
          }

          return {
            id,
            title: forked.data?.title ?? base.title,
            directory: forked.data?.directory ?? base.directory,
          }
        }

        if (base) {
          return {
            id: base.id,
            title: base.title,
            directory: base.directory,
          }
        }

        const name = title()
        const result = await sdk.session.create({
          title: name,
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          return
        }

        return {
          id,
          title: result.data?.title ?? name,
          directory: result.data?.directory,
        }
      }

      async function current(sdk: ForgeClient): Promise<string> {
        if (!args.attach) {
          return directory ?? root
        }

        const next = await sdk.path
          .get()
          .then((x) => x.data?.directory)
          .catch(() => undefined)
        if (next) {
          return next
        }

        UI.error("Failed to resolve remote directory")
        process.exit(1)
      }

      async function localAgent() {
        if (!args.agent) return undefined
        const name = args.agent

        const entry = await Effect.runPromise(
          agentSvc.get(name).pipe(Effect.provideService(InstanceRef, localInstance)),
        )
        if (!entry) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (entry.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return name
      }

      async function attachAgent(sdk: ForgeClient) {
        if (!args.agent) return undefined
        const name = args.agent

        const modes = await sdk.app
          .agents(undefined, { throwOnError: true })
          .then((x) => x.data ?? [])
          .catch(() => undefined)

        if (!modes) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `failed to list agents from ${args.attach}. Falling back to default agent`,
          )
          return undefined
        }

        const agent = modes.find((a) => a.name === name)
        if (!agent) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }

        if (agent.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }

        return name
      }

      async function pickAgent(sdk: ForgeClient) {
        if (!args.agent) return undefined
        if (args.attach) {
          return attachAgent(sdk)
        }

        return localAgent()
      }

      async function execute(sdk: ForgeClient) {
        const sess = await session(sdk)
        if (!sess?.id) {
          UI.error("Session not found")
          process.exit(1)
        }
        const sessionID = sess.id

        function emit(type: string, data: Record<string, unknown>) {
          if (args.format === "json") {
            process.stdout.write(
              JSON.stringify({
                type,
                timestamp: Date.now(),
                sessionID,
                ...data,
              }) + EOL,
            )
            return true
          }
          return false
        }

        // Consume one subscribed event stream for the active session and mirror it
        // to stdout/UI. `client` is passed explicitly because attach mode may
        // rebind the SDK to the session's directory after the subscription is
        // created, and replies issued from inside the loop must use that client.
        async function loop(client: ForgeClient, events: Awaited<ReturnType<typeof sdk.event.subscribe>>) {
          const toggles = new Map<string, boolean>()
          let error: string | undefined

          for await (const event of events.stream) {
            if (
              event.type === "message.updated" &&
              event.properties.sessionID === sessionID &&
              event.properties.info.role === "assistant" &&
              args.format !== "json" &&
              toggles.get("start") !== true
            ) {
              UI.empty()
              UI.println(`> ${event.properties.info.agent} · ${event.properties.info.modelID}`)
              UI.empty()
              toggles.set("start", true)
            }

            if (event.type === "message.part.updated") {
              const part = event.properties.part
              if (part.sessionID !== sessionID) continue

              if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
                if (emit("tool_use", { part })) continue
                if (part.state.status === "completed") {
                  await tool(part)
                  continue
                }
                await toolError(part)
                UI.error(part.state.error)
              }

              if (
                part.type === "tool" &&
                part.tool === "task" &&
                part.state.status === "running" &&
                args.format !== "json"
              ) {
                if (toggles.get(part.id) === true) continue
                await tool(part)
                toggles.set(part.id, true)
              }

              if (part.type === "step-start") {
                if (emit("step_start", { part })) continue
              }

              if (part.type === "step-finish") {
                if (emit("step_finish", { part })) continue
              }

              if (part.type === "text" && part.time?.end) {
                if (emit("text", { part })) continue
                const text = part.text.trim()
                if (!text) continue
                if (!process.stdout.isTTY) {
                  process.stdout.write(text + EOL)
                  continue
                }
                UI.empty()
                UI.println(text)
                UI.empty()
              }

              if (part.type === "reasoning" && part.time?.end && thinking) {
                if (emit("reasoning", { part })) continue
                const text = part.text.trim()
                if (!text) continue
                const line = `Thinking: ${text}`
                if (process.stdout.isTTY) {
                  UI.empty()
                  UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                  UI.empty()
                  continue
                }
                process.stdout.write(line + EOL)
              }
            }

            if (event.type === "session.error") {
              const props = event.properties
              if (props.sessionID !== sessionID || !props.error) continue
              let err = String(props.error.name)
              if ("data" in props.error && props.error.data && "message" in props.error.data) {
                err = String(props.error.data.message)
              }
              error = error ? error + EOL + err : err
              if (emit("error", { error: props.error })) continue
              UI.error(err)
            }

            if (
              event.type === "session.status" &&
              event.properties.sessionID === sessionID &&
              event.properties.status.type === "idle"
            ) {
              break
            }

            if (event.type === "permission.asked") {
              const permission = event.properties
              if (permission.sessionID !== sessionID) continue

              UI.println(
                UI.Style.TEXT_WARNING_BOLD + "!",
                UI.Style.TEXT_NORMAL +
                  `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
              )
              await client.permission.reply({
                requestID: permission.id,
                reply: "reject",
              })
            }
          }
          return error
        }
        const cwd = args.attach ? (directory ?? sess.directory ?? (await current(sdk))) : (directory ?? root)
        const client = args.attach ? attachSDK(cwd) : sdk

        // Validate agent if specified
        const agent = await pickAgent(client)

        const events = await client.event.subscribe()
        const completed = loop(client, events).catch((error) => {
          console.error(error)
          process.exitCode = 1
        })
        async function finish() {
          if (args.attach) return
          const error = await completed
          if (error) process.exitCode = 1
        }

        if (args.command) {
          const result = await client.session.command({
            sessionID,
            agent,
            model: args.model,
            command: args.command,
            arguments: message,
            variant: args.variant,
          })
          if (result.error) {
            if (!emit("error", { error: result.error })) UI.error(formatRunError(result.error))
            process.exitCode = 1
            return
          }
          await finish()
          return
        }

        const model = pick(args.model)
        const result = await client.session.prompt({
          sessionID,
          agent,
          model,
          variant: args.variant,
          parts: [...files, { type: "text", text: message }],
        })
        if (result.error) {
          if (!emit("error", { error: result.error })) UI.error(formatRunError(result.error))
          process.exitCode = 1
          return
        }
        await finish()
      }

      if (args.attach) {
        const sdk = attachSDK(directory)
        return await execute(sdk)
      }

      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const { Server } = await import("@/server/server")
        const request = new Request(input, init)
        const headers = new Headers(request.headers)
        const auth = ServerAuth.header()
        if (auth) headers.set("Authorization", auth)
        return Server.Default().app.fetch(new Request(request, { headers }))
      }) as typeof globalThis.fetch
      const sdk = createForgeClient({
        baseUrl: "http://forge.internal",
        fetch: fetchFn,
        directory,
      })
      await execute(sdk)
    })
  }),
})
