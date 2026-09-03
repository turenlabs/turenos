import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { CrossSpawnSpawner } from "@turenlabs/core/cross-spawn-spawner"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { which } from "@turenlabs/core/util/which"
import { Effect, Layer } from "effect"
import { pathToFileURL } from "url"
import { Agent } from "@/agent/agent"
import { LSP } from "@/lsp/lsp"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { IncomingCallsTool, ReferencesTool, WorkspaceSymbolTool, DefinitionTool, __test } from "@/tool/lsp-symbol"
import { MessageID, SessionID } from "@/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  // Shuts the instance down, which runs the LSP finalizer and stops every
  // language server this file started. Nothing else on the machine is touched.
  await disposeAllInstances()
})

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

/**
 * Payloads below are transcribed from gopls v0.23.0 answering a real Go tree
 * (Gitea, ~3k files). Field names, kinds, line/character values, the
 * `Type.Method` naming, the `detail` string and the `fromRanges` shape are
 * exactly what the server returned. Only the directory prefix of each URI is
 * rebased onto the test instance so relative-path formatting is exercised.
 */
const recorded = (root: string) => {
  const uri = (relative: string) => pathToFileURL(path.join(root, relative)).href
  return {
    openRepository: {
      name: "OpenRepository",
      kind: 12,
      containerName: "gitea.dev/modules/git",
      location: {
        uri: uri("modules/git/repo_base_nogogit.go"),
        range: { start: { line: 36, character: 5 }, end: { line: 36, character: 19 } },
      },
    },
    isEmptyMethod: {
      name: "Repository.IsEmpty",
      kind: 6,
      containerName: "gitea.dev/modules/git",
      location: {
        uri: uri("modules/git/repo.go"),
        range: { start: { line: 83, character: 24 }, end: { line: 83, character: 31 } },
      },
    },
    rendererStruct: {
      name: "Renderer",
      kind: 23,
      containerName: "gitea.dev/modules/markup/markdown",
      location: {
        uri: uri("modules/markup/markdown/markdown.go"),
        range: { start: { line: 237, character: 5 }, end: { line: 237, character: 13 } },
      },
    },
    reference: {
      uri: uri("models/migrations/v1_14/v156.go"),
      range: { start: { line: 110, character: 23 }, end: { line: 110, character: 37 } },
    },
    incomingCall: {
      from: {
        name: "FixPublisherIDforTagReleases",
        kind: 12,
        detail: "gitea.dev/modules/git • v156.go",
        uri: uri("models/migrations/v1_14/v156.go"),
        range: { start: { line: 26, character: 5 }, end: { line: 26, character: 33 } },
        selectionRange: { start: { line: 26, character: 5 }, end: { line: 26, character: 33 } },
      },
      fromRanges: [{ start: { line: 110, character: 23 }, end: { line: 110, character: 37 } }],
    },
  }
}

type Stub = {
  workspaceSymbol?: (query: string) => unknown[]
  references?: () => unknown[]
  incomingCalls?: () => unknown[]
  definition?: () => unknown[]
  status?: () => { id: string; name: string; root: string; status: "connected" }[]
}

const touched: string[] = []

const stubLsp = (stub: Stub) =>
  Layer.succeed(
    LSP.Service,
    LSP.Service.of({
      init: () => Effect.void,
      status: () => Effect.succeed(stub.status?.() ?? [{ id: "gopls", name: "gopls", root: ".", status: "connected" }]),
      hasClients: () => Effect.succeed(true),
      touchFile: (file) =>
        Effect.sync(() => {
          touched.push(file)
        }),
      diagnostics: () => Effect.succeed({}),
      hover: () => Effect.succeed([]),
      definition: () => Effect.succeed(stub.definition?.() ?? []),
      references: () => Effect.succeed(stub.references?.() ?? []),
      implementation: () => Effect.succeed([]),
      documentSymbol: () => Effect.succeed([]),
      workspaceSymbol: (query) => Effect.succeed((stub.workspaceSymbol?.(query) ?? []) as never),
      prepareCallHierarchy: () => Effect.succeed([]),
      incomingCalls: () => Effect.succeed(stub.incomingCalls?.() ?? []),
      outgoingCalls: () => Effect.succeed([]),
    }),
  )

const base = LayerNode.group([Agent.node, FSUtil.node, CrossSpawnSpawner.node, Truncate.node, Ripgrep.node, LSP.node])

const withStub = (stub: Stub) => testEffect(LayerNode.compile(base, [[LSP.node, stubLsp(stub)]]))
const live = testEffect(LayerNode.compile(base))

/**
 * Formatting and resolution, driven by the recorded gopls payloads. These run
 * with the LSP service stubbed so the assertions are about our translation
 * layer, not about the server.
 */
describe("structural LSP tools: translation", () => {
  const root = "/tmp/forge-lsp-fixture"
  const fixture = recorded(root)

  const symbolIt = withStub({ workspaceSymbol: () => [fixture.openRepository] })

  symbolIt.instance("workspace_symbol names the kind and location", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* WorkspaceSymbolTool)
      const out = yield* tool.execute({ name: "OpenRepository" }, ctx)
      expect(out.output).toContain("func OpenRepository")
      // gopls reports 0-based line 36; editors and this tool report 37.
      expect(out.output).toContain(":37:6")
      expect(out.output).toContain("gitea.dev/modules/git")
      expect(out.metadata.count).toBe(1)
    }),
  )

  const refIt = withStub({
    workspaceSymbol: () => [fixture.openRepository],
    references: () => [fixture.reference],
  })

  refIt.instance("references resolves a bare name without any offset from the caller", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* ReferencesTool)
      const out = yield* tool.execute({ symbol: "OpenRepository" }, ctx)
      expect(out.metadata.count).toBe(1)
      expect(out.output).toContain("1 reference to OpenRepository")
      expect(out.output).toContain("declared")
      expect(out.output).toContain(":111:24")
    }),
  )

  const qualifiedIt = withStub({
    workspaceSymbol: () => [fixture.isEmptyMethod],
    references: () => [fixture.reference],
  })

  qualifiedIt.instance("references matches a bare method name against a receiver-qualified symbol", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* ReferencesTool)
      // gopls names this symbol "Repository.IsEmpty"; the model says "IsEmpty".
      const out = yield* tool.execute({ symbol: "IsEmpty" }, ctx)
      expect(out.output).toContain("Repository.IsEmpty")
      expect(out.metadata.count).toBe(1)
    }),
  )

  const ambiguousIt = withStub({
    workspaceSymbol: () => [fixture.openRepository, { ...fixture.openRepository, containerName: "other/pkg" }],
    references: () => [fixture.reference],
  })

  ambiguousIt.instance("references lists same-named alternates so the model can disambiguate", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* ReferencesTool)
      const out = yield* tool.execute({ symbol: "OpenRepository" }, ctx)
      expect(out.output).toContain("share this name")
      expect(out.output).toContain("pass `path`")
    }),
  )

  const callsIt = withStub({
    workspaceSymbol: () => [fixture.openRepository],
    incomingCalls: () => [fixture.incomingCall],
  })

  callsIt.instance("incoming_calls reports the caller, its declaration and its call sites", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* IncomingCallsTool)
      const out = yield* tool.execute({ symbol: "OpenRepository" }, ctx)
      expect(out.output).toContain("1 caller of OpenRepository")
      expect(out.output).toContain("FixPublisherIDforTagReleases")
      expect(out.output).toContain(":27")
      expect(out.output).toContain("calls at 111")
      expect(out.metadata.count).toBe(1)
    }),
  )

  const nonCallableIt = withStub({
    workspaceSymbol: () => [fixture.rendererStruct],
    incomingCalls: () => [],
  })

  nonCallableIt.instance("incoming_calls explains a non-callable symbol instead of implying it has no callers", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* IncomingCallsTool)
      // gopls rejects this outright with "Renderer is not a function", which the
      // LSP client swallows into []. An empty list here would read as "nothing
      // calls it", which is a different and wrong answer.
      const out = yield* tool.execute({ symbol: "Renderer" }, ctx)
      expect(out.output).toContain("is a struct, not a function or method")
      expect(out.output).toContain("no call hierarchy")
      expect(out.output).not.toContain("0 callers")
    }),
  )

  const emptyIt = withStub({ workspaceSymbol: () => [] })

  emptyIt.instance("a name the server does not know says so and points at grep", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* ReferencesTool)
      const out = yield* tool.execute({ symbol: "NoSuchSymbol" }, ctx)
      expect(out.output).toContain("No symbol named")
      expect(out.output).toContain("grep")
      expect(out.metadata.count).toBe(0)
    }),
  )

  const nearIt = withStub({ workspaceSymbol: () => [fixture.isEmptyMethod] })

  nearIt.instance("a near miss lists what the server did return", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* IncomingCallsTool)
      const out = yield* tool.execute({ symbol: "TotallyDifferent" }, ctx)
      expect(out.output).toContain("Closest names")
      expect(out.output).toContain("Repository.IsEmpty")
    }),
  )
})

describe("path formatting", () => {
  const { relativeTo, baseName, identifierColumns } = __test

  test("prefers the project directory over a degenerate '/' worktree", () => {
    // A non-git instance sets worktree to "/", and path.relative("/", file)
    // returns the absolute path with its leading slash removed — a path that
    // does not resolve. Never emit that.
    expect(relativeTo(["/tmp/project", "/"], "/tmp/project/pkg/repo.go")).toBe("pkg/repo.go")
    expect(relativeTo(["/", "/"], "/private/var/x/repo.go")).toBe("/private/var/x/repo.go")
  })

  test("falls back to the absolute path for files outside every root", () => {
    expect(relativeTo(["/tmp/project"], "/usr/lib/go/src/os/file.go")).toBe("/usr/lib/go/src/os/file.go")
  })

  test("picks the most specific of several roots", () => {
    expect(relativeTo(["/tmp/project/sub", "/tmp/project"], "/tmp/project/sub/a.go")).toBe("a.go")
  })

  test("matches bare names against server-qualified symbol names", () => {
    // Real gopls spellings for the same method, from workspace/symbol and
    // documentSymbol respectively.
    expect(baseName("Repository.GetBranchNames")).toBe("GetBranchNames")
    expect(baseName("(*Repository).GetBranchNames")).toBe("GetBranchNames")
    expect(baseName("OpenRepository")).toBe("OpenRepository")
  })

  test("identifier scan takes whole words only", () => {
    expect(identifierColumns("func OpenRepository(name string) {", "OpenRepository")).toEqual([5])
    expect(identifierColumns("myOpenRepositoryHelper()", "OpenRepository")).toEqual([])
    expect(identifierColumns("a(Get); b(Get)", "Get")).toEqual([2, 10])
  })
})

/**
 * End-to-end against a real language server. This is the test that catches the
 * failure the whole design is built around: resolving a name through
 * `documentSymbol` yields the range of the whole declaration, gopls answers
 * "no identifier found", the client swallows it, and the tool reports "no
 * callers" for a function that plainly has two.
 */
const GO_MOD = "module example.com/probe\n\ngo 1.21\n"
const GO_SOURCE = `package probe

// OpenRepository opens a repository by name.
func OpenRepository(name string) string {
	return name
}

func CallerOne() string {
	return OpenRepository("one")
}

func CallerTwo() string {
	return OpenRepository("two")
}
`

/**
 * `LSPServer.Gopls` resolves its binary with `which("gopls")`, so the test is
 * only meaningful when gopls is on PATH. A `go install` puts it in GOBIN/GOPATH
 * bin, which is frequently not on PATH (it is not on this machine), so look
 * there too and extend PATH for the run rather than silently skipping. Without
 * this the suite passes by never executing.
 */
function locateGopls() {
  const found = which("gopls")
  if (found) return found
  const home = process.env.HOME
  const candidates = [
    process.env.GOBIN,
    process.env.GOPATH ? path.join(process.env.GOPATH, "bin") : undefined,
    home ? path.join(home, "go", "bin") : undefined,
  ]
  for (const dir of candidates) {
    if (!dir) continue
    const candidate = path.join(dir, "gopls")
    if (!Bun.file(candidate).size) continue
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`
    return candidate
  }
  return undefined
}

const gopls = locateGopls()
const describeReal = gopls ? describe : describe.skip

describeReal("structural LSP tools against real gopls", () => {
  const seed = (directory: string) =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(directory, "go.mod"), GO_MOD)
      yield* fs.writeWithDirs(path.join(directory, "repo.go"), GO_SOURCE)
    }).pipe(Effect.orDie)

  live.instance(
    "starts gopls on its own and finds both callers by name",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        yield* seed(instance.directory)

        const symbols = yield* Tool.init(yield* WorkspaceSymbolTool)
        const found = yield* symbols.execute({ name: "OpenRepository" }, ctx)
        // No path was passed: the server had to be discovered and started from
        // the project contents alone.
        expect(found.output).toContain("OpenRepository")
        expect(found.output).toContain("repo.go")

        const calls = yield* Tool.init(yield* IncomingCallsTool)
        const callers = yield* calls.execute({ symbol: "OpenRepository" }, ctx)
        expect(callers.output).toContain("CallerOne")
        expect(callers.output).toContain("CallerTwo")
        expect(callers.metadata.count).toBe(2)
        // This instance is not a git repo, so worktree is "/". Paths must still
        // come out project-relative, not as slash-stripped absolute paths.
        expect(callers.output).toContain("repo.go:")
        expect(callers.output).not.toContain("private/var")

        const refs = yield* Tool.init(yield* ReferencesTool)
        const references = yield* refs.execute({ symbol: "OpenRepository" }, ctx)
        // declaration + two call sites
        expect(references.metadata.count).toBe(3)

        const def = yield* Tool.init(yield* DefinitionTool)
        const definition = yield* def.execute(
          { symbol: "OpenRepository", path: path.join(instance.directory, "repo.go") },
          ctx,
        )
        expect(definition.output).toContain("repo.go:4")
      }),
    { config: { lsp: true } },
    120_000,
  )
})
