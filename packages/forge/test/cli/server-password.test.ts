import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { loadServerPassword } from "@/cli/server-password"
import { tmpdir } from "../fixture/fixture"

describe("CLI server password source", () => {
  test("requires a password credential in persistent mode", async () => {
    const error = await rejection(loadServerPassword({ FORGE_SERVER_MODE: "persistent" }))
    expect(error).toMatchObject({ message: "persistent server requires FORGE_SERVER_PASSWORD_CREDENTIAL" })
  })

  test("reads a named systemd credential", async () => {
    await using tmp = await tmpdir()
    // systemd exposes credentials as 0440
    await writeFile(path.join(tmp.path, "forge-server-password"), "credential-password\n", { mode: 0o440 })

    expect(
      await loadServerPassword({
        FORGE_SERVER_MODE: "persistent",
        CREDENTIALS_DIRECTORY: tmp.path,
        FORGE_SERVER_PASSWORD_CREDENTIAL: "forge-server-password",
      }),
    ).toBe("credential-password")
    expect(process.env.FORGE_SERVER_PASSWORD).toBeUndefined()
    expect(
      await rejection(
        loadServerPassword({ CREDENTIALS_DIRECTORY: tmp.path, FORGE_SERVER_PASSWORD_CREDENTIAL: "../escape" }),
      ),
    ).toMatchObject({ message: "systemd credential names must be file names" })
  })

  test("rejects an empty credential", async () => {
    await using tmp = await tmpdir()
    await writeFile(path.join(tmp.path, "forge-server-password"), "\n")

    expect(
      await rejection(
        loadServerPassword({ CREDENTIALS_DIRECTORY: tmp.path, FORGE_SERVER_PASSWORD_CREDENTIAL: "forge-server-password" }),
      ),
    ).toMatchObject({ message: "server password credential is empty" })
  })

  test("rejects an initial environment password in persistent mode", async () => {
    const error = await rejection(
      loadServerPassword({
        FORGE_SERVER_MODE: "persistent",
        FORGE_SERVER_PASSWORD: "must-not-be-in-env",
        FORGE_SERVER_PASSWORD_CREDENTIAL: "forge-server-password",
      }),
    )
    expect(error).toMatchObject({ message: expect.stringContaining("FORGE_SERVER_PASSWORD") })
  })
})

function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (cause) => cause,
  )
}
