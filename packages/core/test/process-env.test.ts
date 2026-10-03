import { describe, expect, test } from "bun:test"
import path from "node:path"
import { ProcessEnv } from "@turenlabs/core/process-env"

const probe = path.join(import.meta.dir, "fixture/process-env-probe.ts")
const posix = process.platform === "win32" ? test.skip : test

async function probePty(mode: string, env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, probe, mode], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "inherit",
  })
  const output = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  return JSON.parse(output).pty as string[]
}

describe("ProcessEnv", () => {
  posix("removes a variable from the environment of PTY children", async () => {
    expect(await probePty("remove", { PROBE_SECRET: "leaked" })).toEqual([])
  })

  posix("SecretVault removes its bootstrap key from the environment of PTY children", async () => {
    expect(
      await probePty("vault", {
        FORGE_SECRET_VAULT_KEY_ID: "probe",
        FORGE_SECRET_VAULT_KEY: Buffer.alloc(32, 1).toString("base64"),
      }),
    ).toEqual([])
  })

  test("removes the variable from process.env", () => {
    process.env.PROCESS_ENV_REMOVE_TEST = "value"
    ProcessEnv.remove(["PROCESS_ENV_REMOVE_TEST", "PROCESS_ENV_NEVER_SET"])
    expect(process.env.PROCESS_ENV_REMOVE_TEST).toBeUndefined()
  })

  test("does not throw when the native library is missing", () => {
    process.env.PROCESS_ENV_REMOVE_TEST = "value"
    expect(() => ProcessEnv.remove(["PROCESS_ENV_REMOVE_TEST"], ["/nonexistent/libnothing.so"])).not.toThrow()
    expect(process.env.PROCESS_ENV_REMOVE_TEST).toBeUndefined()
  })
})
