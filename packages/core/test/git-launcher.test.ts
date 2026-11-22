import { expect } from "bun:test"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { GitLauncher } from "@turenlabs/core/git-launcher"
import { AppProcess } from "@turenlabs/core/process"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(AppProcess.node))
const mac = process.platform === "darwin" ? it.live : it.live.skip

mac("replays the active launcher environment and preserves the staged blob", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    const proc = yield* AppProcess.Service
    const resolve = yield* GitLauncher.make(proc)
    const env = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: root.path,
      XDG_CONFIG_HOME: root.path,
      CPATH: path.join(root.path, "includes with spaces"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    }
    const selected = yield* proc.run(ChildProcess.make("/usr/bin/xcrun", ["--find", "git"], { env }))
    expect(selected.exitCode).toBe(0)
    const first = yield* resolve(root.path, env)
    expect(first?.command).toBe(selected.stdout.toString().trimEnd())
    if (!first) throw new Error("Apple Git resolution failed")
    expect(yield* resolve(root.path, env)).toBe(first)

    yield* Effect.promise(async () => {
      const filter = path.join(root.path, "inspect-filter")
      await Bun.write(
        filter,
        '#!/bin/sh\nprintf "%s\\n" "$SDKROOT" "$CPATH" "$LIBRARY_PATH" "$MANPATH" "$DEVELOPER_DIR"\ncat\n',
      )
      await chmod(filter, 0o700)
      await Bun.write(path.join(root.path, ".gitattributes"), "file.txt filter=inspect\n")
      await Bun.write(path.join(root.path, "file.txt"), "fixture content\n")
    })
    const capture = (command: string, environment: NodeJS.ProcessEnv, index: string) =>
      Effect.gen(function* () {
        const git = (...args: string[]) =>
          proc
            .run(
              ChildProcess.make(command, ["--git-dir", index, "--work-tree", root.path, ...args], {
                cwd: root.path,
                env: environment,
              }),
            )
            .pipe(Effect.flatMap(AppProcess.requireSuccess))
        yield* git("init", "-q")
        yield* git("config", "filter.inspect.clean", "./inspect-filter")
        yield* git("config", "filter.inspect.required", "true")
        yield* git("add", "--", "file.txt")
        return (yield* git("write-tree")).stdout.toString()
      })
    const stock = yield* capture("/usr/bin/git", env, path.join(root.path, "stock.git"))
    expect(yield* capture(first.command, first.env, path.join(root.path, "direct.git"))).toBe(stock)

    const pending = path.join(root.path, "filter-started")
    yield* Effect.promise(async () => {
      await Bun.write(path.join(root.path, "file.txt"), "interrupted content\n")
      await Bun.write(path.join(root.path, "inspect-filter"), "#!/bin/sh\ntouch filter-started\nexec /bin/sleep 30\n")
    })
    const git = (...args: string[]) =>
      proc
        .run(
          ChildProcess.make(
            first.command,
            ["--git-dir", path.join(root.path, "direct.git"), "--work-tree", root.path, ...args],
            { cwd: root.path, env: first.env },
          ),
        )
        .pipe(Effect.flatMap(AppProcess.requireSuccess))
    const staging = yield* Effect.forkChild(git("add", "--", "file.txt"))
    yield* Effect.gen(function* () {
      while (!(yield* Effect.promise(() => Bun.file(pending).exists()))) yield* Effect.sleep("10 millis")
    }).pipe(Effect.timeout("5 seconds"))
    yield* Fiber.interrupt(staging)
    expect((yield* git("write-tree")).stdout.toString()).toBe(stock)
    expect(yield* Effect.promise(() => Bun.file(path.join(root.path, "direct.git", "index.lock")).exists())).toBe(false)

    const changed = yield* resolve(root.path, { ...env, CPATH: path.join(root.path, "different") })
    expect(changed?.env.CPATH).toContain("different")
    expect(changed?.env.CPATH).not.toContain("includes with spaces")
    const tools = { ...env, DEVELOPER_DIR: "/Library/Developer/CommandLineTools" }
    const toolsGit = yield* proc.run(ChildProcess.make("/usr/bin/xcrun", ["--find", "git"], { env: tools }))
    if (toolsGit.exitCode === 0 && !toolsGit.stderr.length) {
      const alternate = yield* resolve(root.path, tools)
      expect(alternate?.command).toBe(toolsGit.stdout.toString().trimEnd())
      expect(alternate?.env.DEVELOPER_DIR).toBe(tools.DEVELOPER_DIR)
    }
    expect(yield* resolve(root.path, { ...env, DEVELOPER_DIR: path.join(root.path, "missing") })).toBeUndefined()
    expect((yield* resolve(root.path, env))?.command).toBe(first.command)

    const bin = path.join(root.path, "bin")
    yield* Effect.promise(async () => {
      await mkdir(bin)
      await Bun.write(path.join(bin, "git"), "#!/bin/sh\nexit 0\n")
      await chmod(path.join(bin, "git"), 0o700)
    })
    expect(yield* resolve(root.path, { ...env, PATH: `${bin}:${env.PATH}` })).toBeUndefined()
  }),
)
