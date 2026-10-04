import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { version } from "../package.json"
import { parseCli } from "../src/cli"
import { CliError } from "../src/tui-auth"

const nonTty =
  "The dashboard needs an interactive terminal. For scripts and agents, use the commands in turen-tui --help (e.g. turen-tui sessions --json)."
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    // Never inherit operator credentials or invoke the real service manager.
    env: { PATH: "", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

function probe(
  args: string[],
  tty: [boolean, boolean] = [true, true],
  env: NodeJS.ProcessEnv = {},
  importOnly = false,
) {
  return run(
    [
      "--eval",
      `import { plugin } from "bun";
       plugin({ name: "native-boundary", setup(build) {
         build.onLoad({ filter: /[/\\\\]src[/\\\\]index\\.ts$/ }, () => {
           console.error("native-loaded");
           return { loader: "js", contents: "export async function runTui(options) { console.log(JSON.stringify(options)) }" };
         });
       }});
       Object.defineProperty(process.stdin, "isTTY", { value: ${tty[0]} });
       Object.defineProperty(process.stdout, "isTTY", { value: ${tty[1]} });
       Object.defineProperty(process, "getuid", { value: () => {
         console.error("auth-resolved");
         return undefined;
       }});
       const { main } = await import(${JSON.stringify(cli)});
       ${importOnly ? "" : `await main(${JSON.stringify(args)}).catch(error => { console.error(error.message); process.exitCode = 1; });`}`,
    ],
    env,
  )
}

describe("CLI parsing", () => {
  test("URL precedence is positional, environment, then local discovery", () => {
    expect(parseCli([], {})).toEqual({
      kind: "run",
      url: undefined,
      directory: undefined,
      username: undefined,
      discoverAuth: false,
      server: undefined,
    })
    expect(parseCli(["--discover-auth"], {})).toMatchObject({ url: new URL("http://127.0.0.1:4096/") })
    expect(parseCli([], { TURENOS_SERVER_URL: "https://env.example:8443" })).toMatchObject({
      url: new URL("https://env.example:8443/"),
    })
    expect(parseCli(["https://argument.example"], { TURENOS_SERVER_URL: "not a URL" })).toMatchObject({
      url: new URL("https://argument.example/"),
    })
    expect(() => parseCli([], { TURENOS_SERVER_URL: "" })).toThrow(CliError)
  })

  test("parses options without resolving auth and does not enable discovery from the environment", () => {
    expect(
      parseCli(["--username=argument-user", "--dir", "/srv/project", "--discover-auth", "https://example.com"], {
        FORGE_SERVER_USERNAME: "environment-user",
        FORGE_SERVER_PASSWORD: "test-only-password",
      }),
    ).toEqual({
      kind: "run",
      url: new URL("https://example.com/"),
      directory: "/srv/project",
      username: "argument-user",
      discoverAuth: true,
      server: undefined,
    })
    expect(parseCli([], { TURENOS_DISCOVER_AUTH: "true" })).toMatchObject({ discoverAuth: false })
  })

  for (const directory of [
    "/",
    "/srv/nonexistent project",
    "C:\\work\\project",
    "D:/work/project",
    "\\\\host\\share\\project",
  ]) {
    test(`accepts an absolute server directory ${JSON.stringify(directory)} without local filesystem access`, () => {
      expect(parseCli(["--dir", directory], {})).toMatchObject({ directory })
    })
  }

  for (const directory of [
    "",
    ".",
    "../project",
    "~/project",
    "C:project",
    "/srv/\0project",
    "/srv/\nproject",
    "/srv/\tproject",
    "/srv/\u202eproject",
    "\\project",
  ]) {
    test(`rejects a non-absolute or invalid directory ${JSON.stringify(directory)}`, () => {
      expect(() => parseCli(["--dir", directory], {})).toThrow("--dir must be an absolute directory on the server.")
    })
  }

  for (const address of [
    "https://example.com",
    "https://example.com/",
    "HTTP://127.0.0.1:4096",
    "http://[::1]:9000/",
  ]) {
    test(`accepts origin ${address}`, () => {
      expect(parseCli([address], {})).toMatchObject({ url: new URL(address) })
    })
  }

  for (const address of [
    "",
    "not-a-url",
    "example.com:4096",
    "ftp://example.com",
    "file:///tmp/server",
    "https:example.com",
    "http:///example.com",
    "https://example.com:99999",
    "https://user:synthetic-secret@example.com",
    "https://user@example.com",
    "https://@example.com",
    "https://example.com/prefix",
    "https://example.com/prefix/..",
    "https://example.com/%2e/",
    "https://example.com//",
    "https://example.com/?token=synthetic-secret",
    "https://example.com/?",
    "https://example.com/#synthetic-secret",
    "https://example.com/#",
    "https://example.com\\prefix",
    "https://example.com\n",
    "https://example.com/\n",
    "https://example.com\0",
    "https://exam\tple.com",
  ]) {
    test(`rejects non-origin URL ${JSON.stringify(address)}`, () => {
      expect(() => parseCli([address], {})).toThrow(CliError)
      expect(() => parseCli([], { TURENOS_SERVER_URL: address })).toThrow(CliError)
    })
  }

  test("rejects oversized URL input before parsing", () => {
    expect(() => parseCli([`https://${"a".repeat(8192)}.example`], {})).toThrow("at most 8192 characters")
  })

  for (const args of [
    ["--unknown=synthetic-secret"],
    ["--password", "synthetic-secret"],
    ["--username"],
    ["--dir"],
    ["--username", "--discover-auth"],
    ["--discover-auth=true"],
    ["--discover-auth=false"],
    ["--help=synthetic-secret"],
    ["https://one.example", "https://two.example"],
  ]) {
    test(`rejects invalid arguments ${JSON.stringify(args)} without echoing their values`, () => {
      expect(() => parseCli(args, {})).toThrow(CliError)
      try {
        parseCli(args, {})
      } catch (error) {
        expect((error as Error).message).not.toContain("synthetic-secret")
      }
    })
  }

  test("--server opens a saved server instead of the environment URL but cannot be combined with a URL", () => {
    expect(parseCli(["--server", "eaw"], { TURENOS_SERVER_URL: "https://env.example" })).toMatchObject({
      url: undefined,
      server: "eaw",
    })
    expect(() => parseCli(["--server", "eaw", "https://example.com"], {})).toThrow("either a server URL or --server")
    for (const name of ["", " ", "a\nb", "x".repeat(129)])
      expect(() => parseCli(["--server", name], {})).toThrow("--server must name a saved server.")
  })

  test("supports the end-of-options marker", () => {
    expect(parseCli(["--", "https://example.com"], {})).toMatchObject({ url: new URL("https://example.com/") })
  })

  for (const flag of ["--help", "-h", "--version", "-v"]) {
    test(`${flag} does not validate unused environment configuration`, () => {
      expect(parseCli([flag], { TURENOS_SERVER_URL: "invalid" })).toEqual({
        kind: flag === "--help" || flag === "-h" ? "help" : "version",
      })
    })
  }
})

describe("CLI entrypoint", () => {
  test("malformed and oversized directories fail before auth resolution or native loading", async () => {
    for (const directory of ["/srv/\nproject", "/" + "x".repeat(4096), "\\project"]) {
      const result = await probe(["--dir", directory, "--discover-auth"])
      expect(result).toEqual({
        stdout: "",
        stderr: "--dir must be an absolute directory on the server.\n",
        exitCode: 1,
      })
    }
  })

  test("importing the CLI does not run it, resolve auth, or import the native TUI", async () => {
    expect(await probe([], [true, true], {}, true)).toEqual({ stdout: "", stderr: "", exitCode: 0 })
  })

  for (const flag of ["--help", "-h"]) {
    test(`${flag} works without a TTY and describes the standalone options`, async () => {
      const result = await run([cli, flag], { TURENOS_SERVER_URL: "invalid" })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      for (const text of [
        "turen-tui [url]",
        "--dir",
        "--username",
        "--discover-auth",
        "--version",
        "FORGE_SERVER_PASSWORD",
      ]) {
        expect(result.stdout).toContain(text)
      }
    })
  }

  for (const flag of ["--version", "-v"]) {
    test(`${flag} prints the package version without a TTY`, async () => {
      expect(await run([cli, flag], { TURENOS_SERVER_URL: "invalid" })).toEqual({
        stdout: `${version}\n`,
        stderr: "",
        exitCode: 0,
      })
    })
  }

  test("the bin rejects piped input/output with a sanitized diagnostic", async () => {
    const result = await run([cli, "--discover-auth"], { FORGE_SERVER_PASSWORD: "test-only-password" })
    expect(result).toEqual({
      stdout: "",
      stderr: `turen-tui: ${nonTty}\n`,
      exitCode: 1,
    })
  })

  for (const args of [
    ["--unknown=synthetic-secret"],
    ["https://user:synthetic-secret@example.com"],
    ["--dir", "synthetic-secret"],
  ]) {
    test(`the bin sanitizes invalid input ${JSON.stringify(args)}`, async () => {
      const result = await run([cli, ...args])
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toStartWith("turen-tui: ")
      expect(result.stderr).not.toContain("synthetic-secret")
      expect(result.stderr).not.toContain("\n    at ")
      expect(result.stderr.trim().split("\n")).toHaveLength(1)
    })
  }

  for (const tty of [
    [false, true],
    [true, false],
    [false, false],
  ] as [boolean, boolean][]) {
    test(`requires both terminals before auth resolution or native import: ${JSON.stringify(tty)}`, async () => {
      const result = await probe(["--discover-auth"], tty)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe(`${nonTty}\n`)
    })
  }

  for (const args of [
    ["--help"],
    ["--version"],
    ["--unknown"],
    ["https://example.com/prefix"],
    ["--dir", "relative"],
  ]) {
    test(`does not resolve auth or load native code for ${JSON.stringify(args)} even with a TTY`, async () => {
      const result = await probe(args)
      expect(result.stderr).not.toContain("auth-resolved")
      expect(result.stderr).not.toContain("native-loaded")
      expect(result.exitCode).toBe(args[0] === "--help" || args[0] === "--version" ? 0 : 1)
    })
  }

  test("checks credential transport through the auth helper before native import", async () => {
    const result = await probe(["http://localhost:4096"], [true, true], { FORGE_SERVER_PASSWORD: "test-only-password" })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe(
      "auth-resolved\nServer credentials require HTTPS, or HTTP on 127.0.0.1 or [::1] for an SSH tunnel.\n",
    )
  })

  for (const username of ["", "user:password", "user\nname", "u".repeat(513)]) {
    test(`validates username before native import (${username.length} characters)`, async () => {
      const result = await probe(["--username", username])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("Use a valid username")
      expect(result.stderr).not.toContain("native-loaded")
    })
  }

  test("passes validated connection options to the existing runTui only after auth", async () => {
    const result = await probe(
      ["https://argument.example", "--dir", "C:\\server\\project", "--username", "argument-user"],
      [true, true],
      {
        TURENOS_SERVER_URL: "https://environment.example",
        FORGE_SERVER_USERNAME: "environment-user",
        FORGE_SERVER_PASSWORD: "test-only-password",
      },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("auth-resolved\nnative-loaded\n")
    expect(JSON.parse(result.stdout)).toEqual({
      url: "https://argument.example/",
      directory: "C:\\server\\project",
      username: "argument-user",
      password: "test-only-password",
    })
  })

  test("an empty environment password disables discovery and is passed through unchanged", async () => {
    const result = await probe(["--discover-auth"], [true, true], {
      FORGE_SERVER_USERNAME: "environment-user",
      FORGE_SERVER_PASSWORD: "",
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      url: "http://127.0.0.1:4096/",
      username: "environment-user",
      password: "",
    })
  })
})
