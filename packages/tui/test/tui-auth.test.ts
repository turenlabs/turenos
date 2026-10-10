import { describe, expect, test } from "bun:test"
import { CliError, resolveTuiAuth } from "../src/tui-auth"

const url = new URL("http://127.0.0.1:4096/")

const uid = process.getuid!()
const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

/** Synthetic /proc/net tables: one LISTEN row per [address, port-hex, owner]; tcp6 is empty. */
function proc(...rows: [string, string, number][]) {
  return (path: string) =>
    path.endsWith("tcp6")
      ? HEADER
      : HEADER +
        rows
          .map(([address, port, owner]) => `   0: ${address}:${port} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 ${owner} 0 1 1\n`)
          .join("")
}

/** Our own listener on 127.0.0.1:4096, and on [::1]:9000 in the tcp6 table. */
const ours = (path: string) =>
  path.endsWith("tcp6")
    ? `${HEADER}   0: 00000000000000000000000001000000:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000 ${uid} 0 1 1\n`
    : proc(["0100007F", "1000", uid])(path)

function service(mainPID: () => Promise<string>) {
  return { platform: "linux" as const, uid, mainPID, readProc: ours }
}

test("CliError retains the message constructor and tag without Effect", () => {
  const error = new CliError({ message: "Safe diagnostic" })
  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({ _tag: "CliError", name: "CliError", message: "Safe diagnostic" })
})

describe("TUI local authentication", () => {
  for (const discoverAuth of [undefined, false]) {
    test(`service discovery is skipped with discoverAuth=${discoverAuth}`, async () => {
      const calls: string[] = []
      const auth = await resolveTuiAuth(
        { url, discoverAuth, env: {} },
        service(async () => {
          calls.push("discovery")
          return "0"
        }),
      )
      expect(auth).toEqual({ username: "forge", password: undefined })
      expect(calls).toEqual([])
    })
  }

  for (const password of ["explicit-password", ""]) {
    test(`an explicitly configured ${password ? "password" : "empty password"} skips service discovery`, async () => {
      const calls: string[] = []
      const auth = await resolveTuiAuth(
        {
          url,
          discoverAuth: true,
          env: { FORGE_SERVER_PASSWORD: password, FORGE_SERVER_USERNAME: "configured-user" },
        },
        service(async () => {
          calls.push("discovery")
          return "0"
        }),
      )
      expect(auth).toEqual({ username: "configured-user", password })
      expect(calls).toEqual([])
    })
  }

  for (const address of [
    "http://example.com:4096/",
    "http://localhost:4096/",
    "http://127.0.0.1:4097/",
    "https://127.0.0.1:4096/",
    "http://127.0.0.1:4096/prefix",
    "http://127.0.0.1:4096/?target=local",
    "http://127.0.0.1:4096/#local",
    "http://user:password@127.0.0.1:4096/",
  ]) {
    test(`does not discover credentials for ${address}`, async () => {
      const calls: string[] = []
      const auth = await resolveTuiAuth(
        { url: new URL(address), discoverAuth: true, env: {} },
        service(async () => {
          calls.push("discovery")
          return "0"
        }),
      )
      expect(auth).toEqual({ username: "forge", password: undefined })
      expect(calls).toEqual([])
    })
  }

  for (const host of [
    { platform: "darwin" as const, uid: 1000 },
    { platform: "linux" as const, uid: undefined },
  ]) {
    test(`does not discover credentials with platform=${host.platform} uid=${host.uid}`, async () => {
      const calls: string[] = []
      const auth = await resolveTuiAuth(
        { url, discoverAuth: true, env: {} },
        {
          ...host,
          mainPID: async () => {
            calls.push("discovery")
            return "0"
          },
        },
      )
      expect(auth).toEqual({ username: "forge", password: undefined })
      expect(calls).toEqual([])
    })
  }

  test("unavailable service discovery preserves explicit username precedence", async () => {
    const unavailable = service(async () => {
      throw new Error("Unavailable service manager")
    })
    expect(
      await resolveTuiAuth(
        { url, discoverAuth: true, username: "argument-user", env: { FORGE_SERVER_USERNAME: "environment-user" } },
        unavailable,
      ),
    ).toEqual({ username: "argument-user", password: undefined })
    expect(
      await resolveTuiAuth(
        { url, discoverAuth: true, env: { FORGE_SERVER_USERNAME: "environment-user" } },
        unavailable,
      ),
    ).toEqual({
      username: "environment-user",
      password: undefined,
    })
  })

  for (const pid of ["0", "", "../self", "1\n2", "-1", "1.5", "9007199254740992", "999999999"]) {
    test(`an inactive, malformed, or missing service PID ${JSON.stringify(pid)} has no credentials`, async () => {
      expect(
        await resolveTuiAuth(
          { url, discoverAuth: true, env: {} },
          service(async () => pid),
        ),
      ).toEqual({
        username: "forge",
        password: undefined,
      })
    })
  }

  const procTest = process.platform === "linux" ? test : test.skip
  procTest("reads only auth fields from an owned process and keeps explicit usernames", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"], {
      env: {
        FORGE_SERVER_USERNAME: "service-user",
        FORGE_SERVER_PASSWORD: "service=password=with=equals",
        UNRELATED_SECRET: "must-not-be-returned",
        PREFIX_FORGE_SERVER_PASSWORD: "must-not-match",
      },
      stdout: "ignore",
      stderr: "ignore",
    })
    const local = service(async () => `${child.pid}\n`)
    try {
      expect(await resolveTuiAuth({ url, discoverAuth: true, env: {} }, local)).toEqual({
        username: "service-user",
        password: "service=password=with=equals",
      })
      expect(
        await resolveTuiAuth({ url, discoverAuth: true, env: { FORGE_SERVER_USERNAME: "environment-user" } }, local),
      ).toEqual({
        username: "environment-user",
        password: "service=password=with=equals",
      })
      expect(
        await resolveTuiAuth(
          { url, discoverAuth: true, username: "argument-user", env: { FORGE_SERVER_USERNAME: "environment-user" } },
          local,
        ),
      ).toEqual({ username: "argument-user", password: "service=password=with=equals" })
      expect(
        await resolveTuiAuth({ url, discoverAuth: true, env: {} }, { ...local, uid: (process.getuid?.() ?? 0) + 1 }),
      ).toEqual({
        username: "forge",
        password: undefined,
      })
    } finally {
      child.kill()
      await child.exited
    }
  })

  procTest("a service without an auth password falls back without copying other environment values", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"], {
      env: { PREFIX_FORGE_SERVER_PASSWORD: "not-the-password", UNRELATED_SECRET: "not-auth" },
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      expect(
        await resolveTuiAuth(
          { url, discoverAuth: true, env: {} },
          service(async () => String(child.pid)),
        ),
      ).toEqual({
        username: "forge",
        password: undefined,
      })
    } finally {
      child.kill()
      await child.exited
    }
  })
})

describe("TUI credential transport", () => {
  for (const address of [
    "http://example.com:4096/",
    "http://localhost:4096/",
    "http://127.0.0.2:9000/",
    "http://[::]:4096/",
  ]) {
    test(`rejects credentials over ${address}`, async () => {
      await expect(
        resolveTuiAuth({ url: new URL(address), env: { FORGE_SERVER_PASSWORD: "explicit-password" } }),
      ).rejects.toMatchObject({
        _tag: "CliError",
        message: "Server credentials require HTTPS, or HTTP on 127.0.0.1 or [::1] for an SSH tunnel.",
      })
    })
  }

  for (const address of ["https://example.com:4096/", "http://127.0.0.1:4096/", "http://[::1]:9000/"]) {
    test(`accepts explicit credentials over ${address} without discovery`, async () => {
      const calls: string[] = []
      expect(
        await resolveTuiAuth(
          {
            url: new URL(address),
            username: "argument-user",
            env: { FORGE_SERVER_USERNAME: "environment-user", FORGE_SERVER_PASSWORD: "explicit-password" },
          },
          service(async () => {
            calls.push("discovery")
            return "0"
          }),
        ),
      ).toEqual({ username: "argument-user", password: "explicit-password" })
      expect(calls).toEqual([])
    })
  }

  for (const password of [undefined, ""]) {
    test(`allows remote HTTP without credentials when password=${JSON.stringify(password)}`, async () => {
      expect(
        await resolveTuiAuth({
          url: new URL("http://example.com:4096/"),
          discoverAuth: true,
          env: { FORGE_SERVER_PASSWORD: password },
        }),
      ).toEqual({ username: "forge", password })
    })
  }
})
