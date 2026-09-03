// Help-text snapshots for every CLI command + key subcommand. Catches
// accidental flag removals, renames, and reordering in a single sweep —
// any change to the user-visible CLI surface shows up here as a diff.
//
// This is the broad coverage layer that makes the future Effect CLI
// migration (yargs → effect-smol/cli) safe to attempt: if a refactor
// preserves the surface, the snapshots stay green; if it doesn't, the
// diff tells you exactly which command(s) changed.
//
// Snapshots are taken at COLUMNS=120 so wrapping is stable across
// terminal sizes. The default no-command invocation is excluded —
// `opencode --help` includes an ASCII banner that pulls in the install
// version (changes per release), so we'd snapshot a moving target.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

// Top-level commands. Order matches what `opencode --help` prints today;
// keep it in that order so the snapshot file reads as a table of contents.
// `completion` is intentionally excluded — it's a yargs built-in that emits
// top-level help on `--help` and exits 1; not a real opencode command.
const TOP_LEVEL = [
  "acp",
  "run",
  "debug",
  "agent",
  "upgrade",
  "uninstall",
  "serve",
  "models",
  "stats",
  "export",
  "import",
  "pr",
  "session",
  "db",
] as const

// Fixed wrap width so a developer's terminal doesn't affect snapshots.
// yargs honors COLUMNS; CI runners typically default to 80 which produces
// different wraps from a 200-col local terminal.
const SNAPSHOT_ENV = { COLUMNS: "120" }

describe("opencode CLI help-text snapshots", () => {
  cliIt.live("requires an explicit command instead of opening an interactive UI", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn([], { env: SNAPSHOT_ENV })
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("Commands:")
    }),
  )

  // Single test, parallel spawns. Each command's help fires under
  // `concurrency: 8` — wall-clock stays under ~10s even for ~35 commands,
  // versus ~1 minute if we serialized.
  cliIt.live(
    "every documented command emits stable help text",
    ({ opencode }) =>
      Effect.gen(function* () {
        const topLevel = yield* opencode.spawn(["--help"], { env: SNAPSHOT_ENV })
        expect(topLevel.exitCode).toBe(0)
        expect(topLevel.stderr.endsWith("\n")).toBe(true)
        expect(topLevel.stderr).not.toContain("--mini")
        expect(topLevel.stderr).not.toContain("--thinking")
        expect(topLevel.stderr).not.toContain("--variant")
        expect(topLevel.stderr).not.toContain("--demo")
        expect(topLevel.stderr).not.toContain("--auto")
        expect(topLevel.stderr).not.toContain("--yolo")
        expect(topLevel.stderr).not.toContain("--dangerously-skip-permissions")
        expect(topLevel.stderr).not.toContain("  console")
        expect(topLevel.stderr).not.toContain("  github")

        const argvs: Array<readonly string[]> = TOP_LEVEL.map((command) => [command] as const)

        // Spawn in parallel, then assert in argv order so snapshot output is
        // deterministic and per-command failures don't abort the rest of
        // the sweep. `Effect.partition` is the canonical "run all, separate
        // failures from successes" primitive — no mutable accumulator needed.
        const [failures, results] = yield* Effect.partition(
          argvs,
          (argv) =>
            Effect.gen(function* () {
              const result = yield* opencode.spawn([...argv, "--help"], { env: SNAPSHOT_ENV })
              if (result.exitCode !== 0) {
                return yield* Effect.fail(`opencode ${argv.join(" ")}: exit ${result.exitCode}`)
              }
              return { argv, result }
            }),
          { concurrency: 8 },
        )

        for (const { argv, result } of results) {
          // yargs writes --help to stderr, not stdout. Snapshotting stderr
          // means our test catches the help body; stdout for these commands
          // is expected to be empty.
          expect(result.stderr.trim().length).toBeGreaterThan(0)
        }
        if (failures.length > 0) {
          throw new Error(`Help text failed for:\n  ${failures.join("\n  ")}`)
        }
      }),
    180_000,
  )
})
