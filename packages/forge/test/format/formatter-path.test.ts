import { expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { ruff, ocamlformat } from "../../src/format/formatter"
import { tmpdir } from "../fixture/fixture"

for (const bin of [".local/bin", "bin"]) {
  for (const fixture of [
    { formatter: ruff, config: "ruff.toml", content: "", args: ["format", "source.py"] },
    { formatter: ruff, config: "pyproject.toml", content: "[tool.ruff]", args: ["format", "source.py"] },
    { formatter: ruff, config: "requirements.txt", content: "ruff", args: ["format", "source.py"] },
    { formatter: ocamlformat, config: ".ocamlformat", content: "", args: ["-i", "source.ml"] },
  ]) {
    test.skipIf(process.platform === "win32")(
      `${fixture.formatter.name} launches from ~/${bin} with ${fixture.config}`,
      async () => {
        await using tmp = await tmpdir()
        const executable = `${tmp.path}/${bin}/${fixture.formatter.name}`
        await Bun.write(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
        await chmod(executable, 0o755)
        await Bun.write(`${tmp.path}/${fixture.config}`, fixture.content)
        const previousPath = process.env.PATH
        const previousHome = process.env.FORGE_TEST_HOME
        try {
          process.env.PATH = "/usr/bin:/bin"
          process.env.FORGE_TEST_HOME = tmp.path
          const command = await fixture.formatter.enabled({
            directory: tmp.path,
            worktree: tmp.path,
            experimentalOxfmt: false,
          })
          expect(command).not.toBe(false)
          if (!command) throw new Error("formatter was not enabled")
          expect(command[0]).toBe(executable)
          const result = spawnSync(
            command[0],
            command.slice(1).map((arg) => arg.replace("$FILE", fixture.args.at(-1)!)),
            {
              cwd: tmp.path,
              encoding: "utf8",
            },
          )
          expect(result.error).toBeUndefined()
          expect(result.status).toBe(0)
          expect(result.stdout.trim().split("\n")).toEqual(fixture.args)
        } finally {
          if (previousPath === undefined) delete process.env.PATH
          else process.env.PATH = previousPath
          if (previousHome === undefined) delete process.env.FORGE_TEST_HOME
          else process.env.FORGE_TEST_HOME = previousHome
        }
      },
    )
  }
}
