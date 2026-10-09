// Bun's async assertion typings omit Promise even though rejection assertions must be awaited.
/* oxlint-disable typescript-eslint/await-thenable */
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { Zizmor } from "@/security/integrations/zizmor"
import { ToolError } from "@/security/types"
import { tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"

const workflow = "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n"
const sarif = {
  version: "2.1.0",
  runs: [
    {
      tool: { driver: { name: "zizmor", version: "1.30.1", rules: [] } },
      invocations: [{ executionSuccessful: true }],
      results: [],
    },
  ],
}

const finding = {
  ruleId: "zizmor/template-injection",
  level: "error",
  message: { text: "Untrusted expression in shell script" },
  properties: { "zizmor/severity": "High", "zizmor/confidence": "High" },
  locations: [
    {
      physicalLocation: {
        artifactLocation: { uri: ".github/workflows/ci.yml" },
        region: { startLine: 6, endLine: 6, snippet: { text: "SOURCE_SECRET" } },
      },
    },
  ],
}

function resultScript(results: unknown[], version: string | undefined = "1.30.1") {
  return `const report = ${JSON.stringify({
    ...sarif,
    runs: [
      { ...sarif.runs[0], tool: { driver: { name: "zizmor", version, rules: [{ id: finding.ruleId }] } }, results },
    ],
  })}; console.log(JSON.stringify(report));`
}

async function fixture(
  script = `console.log(JSON.stringify(${JSON.stringify(sarif)}))`,
  env: Record<string, string> = {},
) {
  const original = Object.fromEntries(["PATH", "PATHEXT", ...Object.keys(env)].map((key) => [key, process.env[key]]))
  return tmpdir({
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "workspace", ".github", "workflows"), { recursive: true })
      await fs.mkdir(path.join(dir, "bin"))
      await Bun.write(path.join(dir, "workspace", ".github", "workflows", "ci.yml"), workflow)
      await fs.writeFile(
        path.join(dir, "bin", "zizmor"),
        `#!${process.execPath}\nimport fs from "node:fs";\n` +
          `fs.writeFileSync(${JSON.stringify(path.join(dir, "invocation.json"))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(${JSON.stringify(Object.keys(env))}.map(key => [key, process.env[key]])) }));\n` +
          script,
        { mode: 0o700 },
      )
      process.env.PATH = path.join(dir, "bin")
      // Let Scanner.which find the extensionless shebang fixture on Windows too.
      if (process.platform === "win32") process.env.PATHEXT = `${original.PATHEXT ?? ".EXE;.CMD;.BAT;.COM"};`
      Object.assign(process.env, env)
    },
    dispose: async () => {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  })
}

function scan(dir: string, args: Record<string, unknown> = {}, signal = new AbortController().signal) {
  return Zizmor.tools[0].handler(
    args,
    { workspace: path.join(dir, "workspace"), cacheDir: path.join(dir, "cache"), secrets: {} },
    { signal, progress: async () => {} },
  )
}

test("registers exactly the local zizmor tool and executable", async () => {
  const { SecurityRegistry } = await import("@/security/registry")
  const integration = SecurityRegistry.integration("zizmor")
  expect(integration?.executables).toEqual(["zizmor"])
  expect(integration?.tools.map((tool) => tool.name)).toEqual(["zizmor_scan"])
  expect(integration?.tools[0].inputSchema).toMatchObject({ additionalProperties: false })
  expect(Object.keys(integration?.tools[0].inputSchema.properties ?? {})).toEqual(["path"])
})

test("rejects unknown arguments and non-local or invalid paths before execution", async () => {
  await using tmp = await fixture()
  for (const args of [
    { flags: "--fix" },
    { fix: true },
    { token: "secret" },
    { path: null },
    { path: 1 },
    { path: "" },
    { path: " " },
    { path: "-" },
    { path: "../outside.yml" },
    { path: "https://github.com/owner/repo" },
    { path: "owner/repo@main" },
    { path: "missing.yml" },
    { path: "bad\0.yml" },
    { path: "/etc/passwd" },
  ]) {
    await expect(scan(tmp.path, args)).rejects.toBeInstanceOf(ToolError)
  }
  expect(await Bun.file(path.join(tmp.path, "invocation.json")).exists()).toBe(false)
})

test("collects nested YAML only, preserves bytes, and does not copy configuration", async () => {
  await using tmp = await fixture(`
    const inputs = process.argv.slice(process.argv.indexOf("--") + 1);
    if (inputs.some(p => fs.readFileSync(p, "utf8") !== ${JSON.stringify(workflow)})) process.exit(1);
    if (fs.existsSync(".gitignore") || fs.existsSync("zizmor.yml")) process.exit(2);
    console.log(JSON.stringify(${JSON.stringify(sarif)}));
  `)
  await Bun.write(path.join(tmp.path, "workspace", ".github", "workflows", "nested", "action.yaml"), workflow)
  await Bun.write(path.join(tmp.path, "workspace", ".github", "workflows", ".gitignore"), "*\n")
  await Bun.write(path.join(tmp.path, "workspace", "zizmor.yml"), "rules: {}")
  expect(await scan(tmp.path)).toMatchObject({ coverage: { files: 2 } })
  expect(await scan(tmp.path, { path: ".github/workflows/ci.yml" })).toMatchObject({ coverage: { files: 1 } })
})

// Creating file symlinks on Windows requires host privileges the test suite does not request.
test.skipIf(process.platform === "win32")("refuses symlinked inputs, ancestors, and directory entries", async () => {
  await using tmp = await fixture()
  const root = path.join(tmp.path, "workspace")
  await Bun.write(path.join(tmp.path, "outside.yml"), workflow)
  await fs.symlink(path.join(tmp.path, "outside.yml"), path.join(root, "link.yml"))
  await fs.symlink(path.join(root, ".github"), path.join(root, "linked"))
  for (const input of ["link.yml", "linked/workflows", "linked/workflows/ci.yml"]) {
    await expect(scan(tmp.path, { path: input })).rejects.toBeInstanceOf(ToolError)
  }
  await fs.symlink(path.join(tmp.path, "outside.yml"), path.join(root, ".github/workflows/not-yaml.txt"))
  await expect(scan(tmp.path)).rejects.toBeInstanceOf(ToolError)
  expect(await Bun.file(path.join(tmp.path, "invocation.json")).exists()).toBe(false)
})

test("rejects empty scopes and non-YAML file targets", async () => {
  await using tmp = await fixture()
  await fs.mkdir(path.join(tmp.path, "workspace", "empty"))
  await Bun.write(path.join(tmp.path, "workspace", "readme.txt"), "not YAML")
  for (const input of ["empty", "readme.txt"])
    await expect(scan(tmp.path, { path: input })).rejects.toBeInstanceOf(ToolError)
  expect(await Bun.file(path.join(tmp.path, "invocation.json")).exists()).toBe(false)
})

test("bounds input file bytes before reading", async () => {
  await using tmp = await fixture()
  const file = await fs.open(path.join(tmp.path, "workspace", ".github/workflows/large.yml"), "w")
  await file.truncate(1024 * 1024 + 1)
  await file.close()
  await expect(scan(tmp.path)).rejects.toBeInstanceOf(ToolError)
  expect(await Bun.file(path.join(tmp.path, "invocation.json")).exists()).toBe(false)
})

test("bounds directory depth and YAML file count", async () => {
  await using tmp = await fixture()
  await fs.mkdir(path.join(tmp.path, "workspace", "deep", ...Array.from({ length: 13 }, () => "d")), {
    recursive: true,
  })
  await expect(scan(tmp.path, { path: "deep" })).rejects.toBeInstanceOf(ToolError)
  await Promise.all(
    Array.from({ length: 101 }, (_, n) => Bun.write(path.join(tmp.path, "workspace", "many", `${n}.yml`), workflow)),
  )
  await expect(scan(tmp.path, { path: "many" })).rejects.toBeInstanceOf(ToolError)
  expect(await Bun.file(path.join(tmp.path, "invocation.json")).exists()).toBe(false)
})

test("bounds total input bytes and non-YAML directory entries", async () => {
  await using tmp = await fixture()
  await Promise.all(
    Array.from({ length: 9 }, (_, n) =>
      Bun.write(path.join(tmp.path, "workspace", "large", `${n}.yml`), Buffer.alloc(1024 * 1024)),
    ),
  )
  await expect(scan(tmp.path, { path: "large" })).rejects.toThrow(/byte limits/)
  await Promise.all(
    Array.from({ length: 2049 }, (_, n) => Bun.write(path.join(tmp.path, "workspace", "entries", `${n}.txt`), "")),
  )
  await expect(scan(tmp.path, { path: "entries" })).rejects.toThrow(/entry\/depth limits/)
  expect(await Bun.file(path.join(tmp.path, "invocation.json")).exists()).toBe(false)
})

test("missing binary gives an actionable error without installing", async () => {
  await using tmp = await fixture()
  await fs.rm(path.join(tmp.path, "bin", "zizmor"))
  await expect(scan(tmp.path)).rejects.toThrow(/not installed or not on PATH/)
  expect(await fs.readdir(path.join(tmp.path, "bin"))).toEqual([])
})

test("already-cancelled requests never launch a scanner", async () => {
  await using tmp = await fixture()
  await expect(scan(tmp.path, {}, AbortSignal.abort())).rejects.toThrow(/cancelled/)
  expect(await Bun.file(path.join(tmp.path, "invocation.json")).exists()).toBe(false)
})

test("removes inherited zizmor configuration and GitHub credentials", async () => {
  const env = {
    ZIZMOR_CONFIG: "/unsafe/config",
    ZIZMOR_OFFLINE: "false",
    ZIZMOR_NO_ONLINE_AUDITS: "false",
    ZIZMOR_RENDER_LINKS: "invalid",
    ZIZMOR_SHOW_AUDIT_URLS: "invalid",
    ZIZMOR_GITHUB_TOKEN: "secret",
    GH_TOKEN: "secret",
    GITHUB_TOKEN: "secret",
    GH_ENTERPRISE_TOKEN: "secret",
    GITHUB_ENTERPRISE_TOKEN: "secret",
    GH_HOST: "untrusted.example",
  }
  await using tmp = await fixture(undefined, env)
  await scan(tmp.path)
  const invocation = await Bun.file(path.join(tmp.path, "invocation.json")).json()
  for (const key of Object.keys(env)) expect(invocation.env[key]).toBeUndefined()
})

test.each([1, 3])("fails closed on zizmor exit %i without disclosing stderr", async (code) => {
  await using tmp = await fixture(
    `console.error("SOURCE_SECRET"); console.log(JSON.stringify(${JSON.stringify(sarif)})); process.exit(${code})`,
  )
  await expect(scan(tmp.path)).rejects.toThrow(
    `zizmor failed (exit ${code}); check YAML syntax or install/update zizmor separately and retry`,
  )
  const invocation = await Bun.file(path.join(tmp.path, "invocation.json")).json()
  expect(await fs.stat(invocation.cwd).catch(() => undefined)).toBeUndefined()
})

test("reports a usage error as a version requirement without disclosing stderr", async () => {
  await using tmp = await fixture(`console.error("error: unexpected argument '--no-ignores' SOURCE_SECRET"); process.exit(2)`)
  await expect(scan(tmp.path)).rejects.toThrow(
    "zizmor rejected its arguments (exit 2); zizmor 1.25.0 or newer is required, update it separately and retry",
  )
  const invocation = await Bun.file(path.join(tmp.path, "invocation.json")).json()
  expect(await fs.stat(invocation.cwd).catch(() => undefined)).toBeUndefined()
})

test("fails closed on truncated stdout or stderr", async () => {
  for (const stream of ["stdout", "stderr"]) {
    await using tmp = await fixture(
      `process.${stream}.write("x".repeat(4 * 1024 * 1024 + 1)); console.log(JSON.stringify(${JSON.stringify(sarif)}))`,
    )
    await expect(scan(tmp.path)).rejects.toThrow(/output.*limit|truncated/)
  }
})

test("cancellation terminates a running scanner and removes staging", async () => {
  await using tmp = await fixture("setInterval(() => {}, 1000)")
  const controller = new AbortController()
  const pending = scan(tmp.path, {}, controller.signal)
  await Effect.runPromise(
    pollWithTimeout(
      Effect.promise(async () =>
        (await Bun.file(path.join(tmp.path, "invocation.json")).exists()) ? true : undefined,
      ),
      "scanner did not start",
    ),
  )
  controller.abort()
  await expect(pending).rejects.toThrow(/cancelled/)
  const invocation = await Bun.file(path.join(tmp.path, "invocation.json")).json()
  expect(await fs.stat(invocation.cwd).catch(() => undefined)).toBeUndefined()
})

test("times out a stalled scanner and removes staging", async () => {
  await using tmp = await fixture(`setTimeout(() => console.log(JSON.stringify(${JSON.stringify(sarif)})), 31_000)`)
  await expect(scan(tmp.path)).rejects.toThrow(/timed out/)
  const invocation = await Bun.file(path.join(tmp.path, "invocation.json")).json()
  expect(await fs.stat(invocation.cwd).catch(() => undefined)).toBeUndefined()
}, 60_000)

test("normalizes findings, strips snippets, and retains original source locations", async () => {
  await using tmp = await fixture(
    resultScript([finding]).replace(
      "console.log",
      `report.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri = (await import("node:url")).pathToFileURL(process.argv.at(-1)).href; console.log`,
    ),
  )
  const report = await scan(tmp.path)
  expect(report).toMatchObject({
    total: 1,
    truncated: false,
    findings: [
      {
        ruleId: finding.ruleId,
        message: finding.message.text,
        severity: "high",
        file: path.join(".github", "workflows", "ci.yml"),
        startLine: 6,
        endLine: 6,
        tool: "zizmor",
      },
    ],
  })
  expect(JSON.stringify(report)).not.toContain("SOURCE_SECRET")
  expect(JSON.stringify(report)).not.toContain("forge-zizmor-")
})

test("bounds findings and scalar fields below the server byte cap", async () => {
  await using tmp = await fixture(
    resultScript(Array.from({ length: 60 }, () => ({ ...finding, message: { text: '😀\\"'.repeat(2000) } }))),
  )
  const output = await scan(tmp.path)
  const report = Schema.decodeUnknownSync(
    Schema.Struct({
      total: Schema.Number,
      truncated: Schema.Boolean,
      findings: Schema.Array(Schema.Struct({ message: Schema.String })),
    }),
  )(output)
  expect(report.total).toBe(60)
  expect(report.truncated).toBe(true)
  expect(report.findings.length).toBeGreaterThan(0)
  expect(report.findings.length).toBeLessThanOrEqual(50)
  expect(report.findings.every((item) => item.message.length <= 400)).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(50_000)
})

test("preserves informational severity and reports missing version explicitly", async () => {
  await using tmp = await fixture(
    resultScript([{ ...finding, level: "note", properties: { "zizmor/severity": "Informational" } }], "").replace(
      '"version":""',
      '"unrelated":""',
    ),
  )
  expect(await scan(tmp.path)).toMatchObject({ version: "unavailable", findings: [{ severity: "info" }] })
})

test.each([
  "",
  "not-json",
  "null",
  "{}",
  JSON.stringify({ version: "2.0.0", runs: [] }),
  JSON.stringify({ ...sarif, runs: [] }),
  JSON.stringify({ ...sarif, runs: [{ ...sarif.runs[0], results: undefined }] }),
  JSON.stringify({ ...sarif, runs: [{ ...sarif.runs[0], results: {} }] }),
  JSON.stringify({ ...sarif, runs: [{ ...sarif.runs[0], results: [{}] }] }),
  JSON.stringify({ ...sarif, runs: [{ ...sarif.runs[0], invocations: [{ executionSuccessful: false }] }] }),
])("rejects malformed or incompatible SARIF %#", async (output) => {
  await using tmp = await fixture(`console.log(${JSON.stringify(output)})`)
  await expect(scan(tmp.path)).rejects.toBeInstanceOf(ToolError)
  const invocation = await Bun.file(path.join(tmp.path, "invocation.json")).json()
  expect(await fs.stat(invocation.cwd).catch(() => undefined)).toBeUndefined()
})

test("rejects suppressed, unlocated, and out-of-scope findings", async () => {
  for (const result of [
    { ...finding, suppressions: [{ kind: "inSource" }] },
    { ...finding, locations: [] },
    { ...finding, ruleId: undefined },
    {
      ...finding,
      locations: [
        { physicalLocation: { ...finding.locations[0].physicalLocation, artifactLocation: { uri: "../outside.yml" } } },
      ],
    },
    {
      ...finding,
      locations: [{ physicalLocation: { ...finding.locations[0].physicalLocation, region: { startLine: -1 } } }],
    },
  ]) {
    await using tmp = await fixture(resultScript([result]))
    await expect(scan(tmp.path)).rejects.toBeInstanceOf(ToolError)
  }
})

test("accepts clean zizmor SARIF that omits the unused rule catalog", async () => {
  // Captured shape from zizmor 1.30.1: a clean report has results: [] and no driver.rules.
  const clean = {
    ...sarif,
    runs: [{ ...sarif.runs[0], tool: { driver: { name: "zizmor", version: "1.30.1" } } }],
  }
  await using tmp = await fixture(`console.log(JSON.stringify(${JSON.stringify(clean)}))`)
  expect(await scan(tmp.path)).toMatchObject({ total: 0, findings: [], version: "1.30.1", truncated: false })
})

test("scans the default workflow scope offline in disposable staging", async () => {
  await using tmp = await fixture()
  const report = await scan(tmp.path)
  expect(report).toMatchObject({
    tool: "zizmor",
    target: path.join(".github", "workflows"),
    total: 0,
    findings: [],
    truncated: false,
    coverage: { offline: true, onlineAudits: false, files: 1, complete: true },
    version: "1.30.1",
  })
  const invocation = await Bun.file(path.join(tmp.path, "invocation.json")).json()
  expect(invocation.argv.slice(0, -2)).toEqual([
    "--offline",
    "--no-config",
    "--no-ignores",
    "--strict-collection",
    "--persona=auditor",
    "--format=sarif",
    "--color=never",
  ])
  expect(invocation.argv.at(-2)).toBe("--")
  expect(invocation.argv.at(-1)).toBe(path.join(invocation.cwd, ".github", "workflows", "ci.yml"))
  expect(invocation.cwd).not.toContain(path.join(tmp.path, "workspace"))
  expect(await fs.stat(invocation.cwd).catch(() => undefined)).toBeUndefined()
  expect(await Bun.file(path.join(tmp.path, "workspace", ".github", "workflows", "ci.yml")).text()).toBe(workflow)
})
