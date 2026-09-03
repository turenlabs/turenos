import { describe, expect, test } from "bun:test"
import { resolveForgeCliEnv } from "./forge-cli"

describe("resolveForgeCliEnv", () => {
  test("uses the top-level packaged resource", () => {
    expect(
      resolveForgeCliEnv({
        packaged: true,
        platform: "darwin",
        resourcesPath: "/Applications/Forge.app/Contents/Resources",
        appPath: "/Applications/Forge.app/Contents/Resources/app.asar",
      }),
    ).toEqual({
      FORGE_CLI_COMMAND: "/Applications/Forge.app/Contents/Resources/forge-cli",
    })
  })

  test("selects the executable resource on Windows", () => {
    expect(
      resolveForgeCliEnv({
        packaged: true,
        platform: "win32",
        resourcesPath: "/resources",
        appPath: "/resources/app.asar",
      }),
    ).toEqual({ FORGE_CLI_COMMAND: "/resources/forge-cli.exe" })
  })

  test("runs the checked-out TurenOS entrypoint in development", () => {
    expect(
      resolveForgeCliEnv(
        {
          packaged: false,
          platform: "darwin",
          resourcesPath: "/Applications/Electron.app/Contents/Resources",
          appPath: "/repo/packages/desktop",
          path: "/missing:/tools/bin:/usr/bin",
        },
        (file) => file === "/tools/bin/bun",
      ),
    ).toEqual({
      FORGE_CLI_COMMAND: "/tools/bin/bun",
      FORGE_CLI_ENTRY: "/repo/packages/forge/src/index.ts",
    })
  })

  test("resolves the Windows Bun executable from PATH", () => {
    expect(
      resolveForgeCliEnv(
        {
          packaged: false,
          platform: "win32",
          resourcesPath: "C:\\Forge\\resources",
          appPath: "/repo/packages/desktop",
          path: '"C:\\Program Files\\Bun";D:\\tools',
        },
        (file) => file === "D:\\tools\\bun.exe",
      ),
    ).toEqual({
      FORGE_CLI_COMMAND: "D:\\tools\\bun.exe",
      FORGE_CLI_ENTRY: "/repo/packages/forge/src/index.ts",
    })
  })

  test("fails clearly when Bun is unavailable in development", () => {
    expect(() =>
      resolveForgeCliEnv(
        {
          packaged: false,
          platform: "linux",
          resourcesPath: "/resources",
          appPath: "/repo/packages/desktop",
          path: "/usr/local/bin:/usr/bin",
        },
        () => false,
      ),
    ).toThrow("Bun was not found on PATH; start TurenOS Desktop with `bun run dev:desktop`")
  })
})
