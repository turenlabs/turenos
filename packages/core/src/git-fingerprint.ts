export * as GitFingerprint from "./git-fingerprint"

import os from "os"
import path from "path"
import { createHash, randomUUID } from "crypto"
import { constants, type BigIntStats } from "fs"
import { lstat, mkdir, open, readdir, readlink, realpath, rm, symlink, writeFile } from "fs/promises"
import whichPkg from "which"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { makeGlobalNode } from "./effect/app-node"
import { KeyedMutex } from "./effect/keyed-mutex"
import { AppProcess } from "./process"

/**
 * Bounded, blob-free comparison fingerprint of a Git worktree (`specs/prior-work.md`, rollout 2a).
 *
 * Policy-free: callers own repository authorization, binding checks, baselines and comparison. The
 * primitive never touches the user's index or object store or a Snapshot store: it reads the user
 * index only through read-only plumbing, hashes raw worktree bytes itself and computes Git-format
 * tree IDs in process, so no object is ever written anywhere. The fingerprint is sampled equality
 * across two passes, not an atomic snapshot, and never proof that content is safe or verified.
 */

export const SCHEME = "fp_v1"

/** Apple `bsd/sys/fcntl.h`. XNU rejects combining it with `O_NOFOLLOW` (EINVAL). */
export const O_NOFOLLOW_ANY = 0x20000000

/** Initial v1 budgets from the spec. Operational limits to tune, not completion promises. */
export const Limits = {
  timeoutMs: 30_000,
  entries: 100_000,
  readBytes: 1024 * 1024 * 1024,
  entryBytes: 16 * 1024 * 1024,
  outputBytes: 16 * 1024 * 1024,
  scratchDirectories: 64,
  anchors: 4096,
}
export type Limits = { readonly [K in keyof typeof Limits]: number }

export const SAMPLES = 8
export const SAMPLE_BYTES = 1024
/**
 * Git 2.36 is the first release where `core.fsmonitor` is a boolean/daemon switch rather than
 * a hook path; older releases would execute the configured value. It also has
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` and `--path-format`.
 */
export const GIT_FLOOR = [2, 36] as const
/**
 * Git 2.45 is the first release with `GIT_NO_LAZY_FETCH`. Older Git could lazily fetch a missing
 * object from a promisor remote, so partial clones are only admitted from this release.
 */
export const PARTIAL_CLONE_FLOOR = [2, 45] as const

export const UnavailableReason = Schema.Literals([
  "platform",
  "git_capability",
  "identity",
  "lock",
  "timeout",
  "entry_limit",
  "read_limit",
  "output_limit",
  "scratch_limit",
  "scratch_unsafe",
  "race",
  "special_file",
  "unmerged",
  "sparse_checkout",
  "partial_clone",
  "object_format",
  "process",
  "git_warning",
  "io",
])
export type UnavailableReason = typeof UnavailableReason.Type

export type PartialReason =
  | "oversized"
  | "unreadable"
  | "path_encoding"
  | "gitlink"
  | "embedded_repository"
  | "symlink_parent"
  | "alias"

export type AnchorUnknownReason = "noncanonical" | "excluded" | "symlink_parent" | "outside_universe" | "indeterminate"

/** Result for one requested anchor, by position. Never repeats the anchor path. */
export type Anchor =
  | { readonly state: "entry"; readonly mode: "100644" | "100755" | "120000"; readonly oid: string }
  | { readonly state: "tree"; readonly oid: string; readonly containsSymlink: boolean }
  | { readonly state: "absent" }
  | { readonly state: "unknown"; readonly reason: AnchorUnknownReason }

export type Completeness =
  | { readonly state: "complete" }
  | {
      readonly state: "partial"
      readonly reasons: readonly PartialReason[]
      readonly excluded: number
      /** At most `SAMPLES` paths, each at most `SAMPLE_BYTES` JSON-encoded bytes; never truncated. */
      readonly samples: readonly string[]
      readonly omitted: boolean
    }

export interface Identity {
  readonly worktree: { readonly dev: number; readonly ino: number }
  readonly common: { readonly dev: number; readonly ino: number; readonly birthtime: number }
}

export type Result =
  | { readonly status: "unavailable"; readonly reason: UnavailableReason }
  | {
      readonly status: "available"
      readonly scheme: typeof SCHEME
      readonly objectFormat: "sha1"
      readonly head?: { readonly commit: string; readonly tree: string }
      readonly root: string
      readonly completeness: Completeness
      readonly anchors: readonly Anchor[]
      /** Identities observed at both ends of the capture, for the caller's own binding checks. */
      readonly identity: Identity
      readonly entries: number
      /** Content bytes hashed by the first pass; the verifying pass is bounded to the same amount. */
      readonly readBytes: number
    }

export interface Input {
  readonly repository: { readonly worktree: string; readonly gitDirectory: string; readonly commonDirectory: string }
  /** Server-owned root for per-capture owner-only scratch directories. */
  readonly scratch: string
  /** Repository-root-relative anchors; results are returned in the same order. */
  readonly anchors?: readonly string[]
  readonly limits?: Partial<Limits>
  /** Absolute Git executable. Defaults to `git` resolved once from the server's PATH. */
  readonly git?: string
  /** Test seam only: runs between the two observation passes. */
  readonly between?: Effect.Effect<void>
  /** Test seam only: runs after an entry's `lstat` and before its protected open, and per read chunk. */
  readonly seam?: (event: { readonly phase: "open" | "chunk"; readonly path: string }) => Effect.Effect<void>
}

export interface Interface {
  /** Never fails: every failure is an `unavailable` result. Interruption propagates. */
  readonly capture: (input: Input) => Effect.Effect<Result>
  /** Remove scratch directories whose owning process is established dead. */
  readonly reclaim: (scratch: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@forge/GitFingerprint") {}

class Stop extends Schema.TaggedErrorClass<Stop>()("GitFingerprint.Stop", { reason: UnavailableReason }) {}

/** Strict canonical anchor form: nonempty POSIX root-relative path with no `.git` component. */
export function canonical(anchor: string) {
  if (!anchor || anchor.length > 4096 || !anchor.isWellFormed() || /[\0\\]/.test(anchor) || /^[A-Za-z]:/.test(anchor))
    return false
  return anchor
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
}

export function supportedPlatform(platform = process.platform, release = os.release()) {
  // Darwin 20 is macOS 11, the admission floor for O_NOFOLLOW_ANY.
  return platform === "darwin" && Number(release.split(".")[0]) >= 20
}

const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY
const CHUNK = 64 * 1024
const OWNER = /^cap-(\d+)-/
// Process-wide: every service instance in this process must see every live scratch directory,
// or one instance's reclaim would treat another's same-PID directory as dead.
const active = new Set<string>()

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const proc = yield* AppProcess.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const swept = new Set<string>()
    // Resolved from the server's own PATH only. The desktop sidecar runs under Node, so no Bun APIs.
    const trusted = whichPkg.sync("git", { nothrow: true })
    // Runtime capability is a property of this process and kernel; cache only a definitive answer.
    let capable: boolean | undefined

    const reclaim = Effect.fn("GitFingerprint.reclaim")(function* (scratch: string) {
      if ((yield* rootState(scratch)) !== "owned") return
      const names = yield* io(() => readdir(scratch)).pipe(Effect.orElseSucceed(() => [] as string[]))
      yield* Effect.forEach(
        names.filter((name) => dead(name, path.join(scratch, name))),
        (name) => io(() => rm(path.join(scratch, name), { recursive: true, force: true })).pipe(Effect.ignore),
        { discard: true },
      )
    })

    const capture = Effect.fn("GitFingerprint.capture")(function* (input: Input) {
      const limits = {
        ...Limits,
        ...Object.fromEntries(Object.entries(input.limits ?? {}).filter((entry) => Number.isFinite(entry[1]))),
      }
      const deadline = Date.now() + limits.timeoutMs
      if (!supportedPlatform()) return unavailable("platform")
      if ((input.anchors?.length ?? 0) > limits.anchors) return unavailable("entry_limit")
      // Reclaim directories left by crashed processes once per scratch root per process.
      if (!swept.has(input.scratch)) {
        swept.add(input.scratch)
        yield* reclaim(input.scratch)
      }
      const state = { acquired: false }
      const work = Effect.gen(function* () {
        const repository = yield* canonicalRepository(input.repository)
        return yield* locks.withLock(repository.worktree)(
          Effect.gen(function* () {
            state.acquired = true
            return yield* Effect.acquireUseRelease(
              scratchDirectory(input.scratch, limits.scratchDirectories, reclaim),
              (directory) =>
                run({
                  proc,
                  repository,
                  directory,
                  limits,
                  deadline,
                  anchors: input.anchors ?? [],
                  git: input.git ?? trusted,
                  between: input.between,
                  seam: input.seam,
                  capability: () =>
                    capable !== undefined
                      ? Effect.succeed(capable)
                      : probeCapability(directory).pipe(
                          Effect.tap((value) =>
                            Effect.sync(() => {
                              if (value !== undefined) capable = value
                            }),
                          ),
                          Effect.map((value) => value === true),
                        ),
                }),
              (directory) =>
                io(() => rm(directory, { recursive: true, force: true })).pipe(
                  Effect.ignore,
                  Effect.ensuring(Effect.sync(() => active.delete(directory))),
                ),
            )
          }),
        )
      })
      const result = yield* work.pipe(
        Effect.timeoutOption(Math.max(0, deadline - Date.now())),
        Effect.map((value) => Option.getOrElse(value, () => unavailable(state.acquired ? "timeout" : "lock"))),
        Effect.catchTag("GitFingerprint.Stop", (stop) => Effect.succeed(unavailable(stop.reason))),
      )
      return result
    })

    return Service.of({ capture, reclaim })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [AppProcess.node] })

interface Run {
  readonly proc: AppProcess.Interface
  readonly repository: { readonly worktree: string; readonly gitDirectory: string; readonly commonDirectory: string }
  readonly directory: string
  readonly limits: Limits
  readonly deadline: number
  readonly anchors: readonly string[]
  readonly git: string | null | undefined
  readonly between?: Effect.Effect<void>
  readonly seam?: Input["seam"]
  readonly capability: () => Effect.Effect<boolean>
}

type Universe = ReadonlyMap<string, { readonly bytes: Buffer; readonly gitlink: boolean; readonly embedded: boolean }>

type Seen =
  | { readonly kind: "blob"; readonly mode: "100644" | "100755" | "120000"; readonly oid: string; readonly sig: string }
  | { readonly kind: "absent" }
  | { readonly kind: "excluded"; readonly reason: PartialReason }

const run = Effect.fnUntraced(function* (context: Run) {
  if (!(yield* context.capability())) return yield* new Stop({ reason: "platform" })
  const git = yield* requireGit(context)
  const before = yield* identity(context.repository)
  yield* verifyDiscovery(git, context.repository)
  const format = (yield* git.text(["rev-parse", "--show-object-format"])).trim()
  if (format !== "sha1") return yield* new Stop({ reason: "object_format" })
  if (yield* git.flag(["config", "--bool", "--get", "core.sparseCheckout"]))
    return yield* new Stop({ reason: "sparse_checkout" })
  // A promisor remote can make a missing object trigger a lazy fetch unless GIT_NO_LAZY_FETCH is honored.
  const partial =
    (yield* git.flag(["config", "--get", "extensions.partialClone"])) ||
    (yield* git.optional(["config", "--get-regexp", "^remote\\..*\\.promisor$"])).trim() !== ""
  if (partial && !atLeast(git.version, PARTIAL_CLONE_FLOOR)) return yield* new Stop({ reason: "partial_clone" })
  const excludes = (yield* git.optional(["config", "--path", "--get", "core.excludesFile"])).trim()
  const metadata = [
    path.join(context.repository.commonDirectory, "info", "exclude"),
    path.join(context.repository.commonDirectory, "config"),
    path.join(context.repository.gitDirectory, "config.worktree"),
    ...(excludes ? [path.resolve(context.repository.worktree, excludes)] : []),
  ]
  const metaBefore = yield* Effect.forEach(metadata, signatureOf)
  const headBefore = yield* head(git)

  // Pass 1 is charged against the content budget. Pass 2 must observe the same bytes, so it is
  // bounded by what pass 1 read and running past that is a race, not a budget verdict.
  const first = yield* universe(git, context.limits, headBefore)
  const pass1 = yield* observe(context, first, { read: 0, limit: context.limits.readBytes, reason: "read_limit" })
  const anchors = yield* Effect.forEach(context.anchors, (anchor) => resolveAnchor(context, anchor, pass1))
  if (context.between) yield* context.between
  const second = yield* universe(git, context.limits, headBefore)
  const pass2 = yield* observe(context, second, { read: 0, limit: pass1.read, reason: "race" })

  // Root or common-directory replacement is reported as such before content differences.
  const after = yield* identity(context.repository)
  if (JSON.stringify(after) !== JSON.stringify(before)) return yield* new Stop({ reason: "identity" })
  if (!sameUniverse(first, second) || !sameSeen(pass1.seen, pass2.seen)) return yield* new Stop({ reason: "race" })
  // Anchor resolution, including literal-absence probes, is part of the verified sample.
  const recheck = yield* Effect.forEach(context.anchors, (anchor) => resolveAnchor(context, anchor, pass2))
  if (JSON.stringify(recheck) !== JSON.stringify(anchors)) return yield* new Stop({ reason: "race" })
  const metaAfter = yield* Effect.forEach(metadata, signatureOf)
  if (metaAfter.join("\n") !== metaBefore.join("\n")) return yield* new Stop({ reason: "race" })
  if (JSON.stringify(yield* head(git)) !== JSON.stringify(headBefore)) return yield* new Stop({ reason: "race" })
  yield* verifyDiscovery(git, context.repository)
  if (JSON.stringify(yield* identity(context.repository)) !== JSON.stringify(before))
    return yield* new Stop({ reason: "identity" })

  const excluded = [...pass1.seen].flatMap(([key, seen]) =>
    seen.kind === "excluded" ? [{ key, reason: seen.reason }] : [],
  )
  const samples = excluded
    .map((item) => decode(first.get(item.key)!.bytes))
    .filter((item): item is string => item !== undefined && Buffer.byteLength(JSON.stringify(item)) <= SAMPLE_BYTES)
    .slice(0, SAMPLES)
  return {
    status: "available",
    scheme: SCHEME,
    objectFormat: "sha1",
    ...(headBefore ? { head: headBefore } : {}),
    root: pass1.tree.oid,
    completeness: excluded.length
      ? {
          state: "partial",
          reasons: [...new Set(excluded.map((item) => item.reason))].toSorted(),
          excluded: excluded.length,
          samples,
          omitted: samples.length < excluded.length,
        }
      : { state: "complete" },
    anchors,
    identity: before,
    entries: [...pass1.seen.values()].filter((seen) => seen.kind === "blob").length,
    readBytes: pass1.read,
  } satisfies Result
})

function unavailable(reason: UnavailableReason): Result {
  return { status: "unavailable", reason }
}

function atLeast(version: readonly [number, number], floor: readonly [number, number]) {
  return version[0] > floor[0] || (version[0] === floor[0] && version[1] >= floor[1])
}

/** Child Git with an explicit allowlisted environment; nothing is inherited from the server. */
const requireGit = Effect.fnUntraced(function* (context: Run) {
  const executable = context.git
  if (!executable || !path.isAbsolute(executable)) return yield* new Stop({ reason: "git_capability" })
  const resolved = yield* io(() => realpath(executable)).pipe(
    Effect.mapError(() => new Stop({ reason: "git_capability" })),
  )
  const home = path.join(context.directory, "home")
  const repository = context.repository
  const base = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "xdg"),
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "none",
    GIT_PROTOCOL_FROM_USER: "0",
  }
  const located = {
    ...base,
    GIT_DIR: repository.gitDirectory,
    GIT_COMMON_DIR: repository.commonDirectory,
    GIT_WORK_TREE: repository.worktree,
  }
  const exec = (
    args: readonly string[],
    options: { env?: Record<string, string>; codes?: readonly number[]; uncapped?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const remaining = context.deadline - Date.now()
      if (remaining <= 0) return yield* new Stop({ reason: "timeout" })
      const result = yield* context.proc
        .run(
          ChildProcess.make(
            resolved,
            [
              "-c",
              `core.hooksPath=${path.join(context.directory, "hooks")}`,
              // An empty value disables fsmonitor on every supported release without running anything.
              "-c",
              "core.fsmonitor=",
              "-c",
              "core.untrackedCache=false",
              "-c",
              "core.virtualFilesystem=",
              // Byte-exact paths: never fold case or precompose Unicode while enumerating.
              "-c",
              "core.ignoreCase=false",
              "-c",
              "core.precomposeUnicode=false",
              ...args,
            ],
            {
              cwd: repository.worktree,
              env: options.env ?? located,
              extendEnv: false,
              stdin: "ignore",
              forceKillAfter: "500 millis",
            },
          ),
          // Each enumeration child is bounded separately; collection stops buffering past the cap.
          {
            maxOutputBytes: options.uncapped ? 4096 : context.limits.outputBytes,
            maxErrorBytes: 4096,
            timeout: remaining,
          },
        )
        .pipe(Effect.mapError(() => new Stop({ reason: Date.now() >= context.deadline ? "timeout" : "process" })))
      if (result.stdoutTruncated) return yield* new Stop({ reason: "output_limit" })
      if (!(options.codes ?? [0]).includes(result.exitCode)) return yield* new Stop({ reason: "process" })
      // Git reports skipped directories (e.g. "could not open directory") on stderr and still
      // exits 0; a warning means the enumeration may be smaller than the declared universe.
      // The text names paths, so it is never surfaced.
      if (result.stderr.length > 0) return yield* new Stop({ reason: "git_warning" })
      return result
    })
  const version = (yield* exec(["version"], { env: base, uncapped: true })).stdout.toString("utf8")
  const match = version.match(/^git version (\d+)\.(\d+)/)
  if (!match) return yield* new Stop({ reason: "git_capability" })
  const parsed = [Number(match[1]), Number(match[2])] as const
  if (!atLeast(parsed, GIT_FLOOR)) return yield* new Stop({ reason: "git_capability" })
  return {
    version: parsed,
    bytes: (args: readonly string[]) => exec(args).pipe(Effect.map((result) => result.stdout)),
    text: (args: readonly string[]) => exec(args).pipe(Effect.map((result) => result.stdout.toString("utf8"))),
    optional: (args: readonly string[]) =>
      exec(args, { codes: [0, 1] }).pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.toString("utf8") : "")),
      ),
    flag: (args: readonly string[]) =>
      exec(args, { codes: [0, 1] }).pipe(
        Effect.map((result) => result.exitCode === 0 && result.stdout.toString("utf8").trim() !== "false"),
      ),
    // Discovery deliberately omits the explicit location, bounded at the worktree's parent.
    discover: () =>
      exec(["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], {
        env: { ...base, GIT_CEILING_DIRECTORIES: path.dirname(repository.worktree) },
      }).pipe(Effect.map((result) => result.stdout.toString("utf8"))),
  }
})

type GitRunner = Effect.Success<ReturnType<typeof requireGit>>

const verifyDiscovery = Effect.fnUntraced(function* (git: GitRunner, repository: Run["repository"]) {
  const lines = (yield* git.discover()).split("\n").filter(Boolean)
  if (lines.length !== 3) return yield* new Stop({ reason: "identity" })
  const found = yield* Effect.forEach(lines, (line) =>
    io(() => realpath(line)).pipe(Effect.mapError(() => new Stop({ reason: "identity" }))),
  )
  if (
    found[0] !== repository.worktree ||
    found[1] !== repository.gitDirectory ||
    found[2] !== repository.commonDirectory
  )
    return yield* new Stop({ reason: "identity" })
})

const head = Effect.fnUntraced(function* (git: GitRunner) {
  // Unpeeled HEAD names no object only on an unborn branch. When it names an object, the commit
  // and tree must resolve: a missing object (e.g. in a partial clone) fails rather than reading
  // as unborn and silently dropping HEAD's paths from the universe.
  if (!(yield* git.optional(["rev-parse", "--verify", "--quiet", "HEAD"])).trim()) return undefined
  const commit = (yield* git.text(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).trim()
  const tree = (yield* git.text(["rev-parse", "--verify", "--quiet", `${commit}^{tree}`])).trim()
  return { commit, tree }
})

/** HEAD/index tracked paths plus untracked non-ignored paths, keyed losslessly by raw bytes. */
const universe = Effect.fnUntraced(function* (
  git: GitRunner,
  limits: Limits,
  commit: { readonly commit: string } | undefined,
) {
  const entries = new Map<string, { bytes: Buffer; gitlink: boolean; embedded: boolean }>()
  const add = (bytes: Buffer, flags: { gitlink?: boolean; embedded?: boolean } = {}) => {
    const key = bytes.toString("latin1")
    const current = entries.get(key)
    entries.set(key, {
      bytes,
      gitlink: Boolean(current?.gitlink || flags.gitlink),
      embedded: Boolean(current?.embedded || flags.embedded),
    })
  }
  for (const record of split(yield* git.bytes(["ls-files", "--stage", "-z"]))) {
    const tab = record.indexOf(9)
    const [mode, , stage] = record.subarray(0, tab).toString("latin1").split(" ")
    if (stage !== "0") return yield* new Stop({ reason: "unmerged" })
    add(record.subarray(tab + 1), { gitlink: mode === "160000" })
  }
  // HEAD is fixed for the capture (rechecked at the end), so list the commit resolved up front.
  if (commit)
    for (const record of split(yield* git.bytes(["ls-tree", "-r", "-z", "--full-tree", commit.commit]))) {
      const tab = record.indexOf(9)
      add(record.subarray(tab + 1), { gitlink: record.subarray(0, tab).toString("latin1").startsWith("160000 ") })
    }
  for (const record of split(yield* git.bytes(["ls-files", "--others", "--exclude-standard", "-z"]))) {
    // Untracked nested repositories are listed as a directory with a trailing slash.
    if (record[record.length - 1] === 47) add(record.subarray(0, record.length - 1), { embedded: true })
    else add(record)
  }
  if (entries.size > limits.entries) return yield* new Stop({ reason: "entry_limit" })
  return entries as Universe
})

/**
 * Content bytes one observation pass may read. Bytes are reserved before they are read, so
 * concurrent readers cannot overshoot `limit`; exceeding it stops the capture with `reason`.
 */
interface Budget {
  read: number
  readonly limit: number
  readonly reason: "read_limit" | "race"
}

const observe = Effect.fnUntraced(function* (context: Run, entries: Universe, budget: Budget) {
  const parents = new Map<string, "directory" | "symlink" | "absent">()
  const gitlinks = [...entries.values()].filter((entry) => entry.gitlink).map((entry) => entry.bytes.toString("latin1"))
  const keys = [...entries.keys()].toSorted((a, b) =>
    Buffer.compare(Buffer.from(a, "latin1"), Buffer.from(b, "latin1")),
  )
  const values = yield* Effect.forEach(
    keys,
    (key) => observeEntry(context, entries.get(key)!, key, gitlinks, parents, budget),
    { concurrency: 8 },
  )
  const seen = new Map<string, Seen>(keys.map((key, index) => [key, values[index]!]))
  // With a case-insensitive or normalizing filesystem two distinct index paths can reach one file;
  // hashing it twice would hide a case-only rename. Exclude both rather than call it complete.
  // Hard links with unrelated names are ordinary separate entries, as in Git.
  const inodes = new Map<string, string>()
  for (const [key, value] of seen) {
    if (value.kind !== "blob") continue
    const inode = value.sig.split(":").slice(0, 2).join(":") + ":" + folded(key)
    const other = inodes.get(inode)
    if (other === undefined) {
      inodes.set(inode, key)
      continue
    }
    seen.set(key, { kind: "excluded", reason: "alias" })
    seen.set(other, { kind: "excluded", reason: "alias" })
  }
  const excluded = keys.filter((key) => seen.get(key)!.kind === "excluded")
  return { seen, excluded, tree: buildTree(seen), read: budget.read }
})

const observeEntry = Effect.fnUntraced(function* (
  context: Run,
  entry: { readonly bytes: Buffer; readonly gitlink: boolean; readonly embedded: boolean },
  key: string,
  gitlinks: readonly string[],
  parents: Map<string, "directory" | "symlink" | "absent">,
  budget: Budget,
) {
  if (Date.now() >= context.deadline) return yield* new Stop({ reason: "timeout" })
  if (entry.gitlink || gitlinks.some((link) => key.startsWith(link + "/")))
    return { kind: "excluded", reason: "gitlink" } satisfies Seen
  if (entry.embedded) return { kind: "excluded", reason: "embedded_repository" } satisfies Seen
  const name = decode(entry.bytes)
  if (name === undefined || !name.split("/").every((part) => part && part !== "." && part !== ".."))
    return { kind: "excluded", reason: "path_encoding" } satisfies Seen
  const parts = name.split("/")
  for (const index of parts.slice(0, -1).keys()) {
    const prefix = parts.slice(0, index + 1).join("/")
    const known = parents.get(prefix) ?? (yield* parentKind(context.repository.worktree + "/" + prefix))
    parents.set(prefix, known)
    if (known === "symlink") return { kind: "excluded", reason: "symlink_parent" } satisfies Seen
    if (known === "absent") return { kind: "absent" } satisfies Seen
  }
  const absolute = context.repository.worktree + "/" + name
  const before = yield* io(() => lstat(absolute, { bigint: true })).pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      error.code === "ENOENT" || error.code === "ENOTDIR"
        ? Effect.succeed(Option.none<BigIntStats>())
        : Effect.fail(new Stop({ reason: "io" })),
    ),
  )
  if (Option.isNone(before)) return { kind: "absent" } satisfies Seen
  const stats = before.value
  // A directory at a tracked path means the file is gone; its contents are enumerated separately.
  if (stats.isDirectory()) return { kind: "absent" } satisfies Seen
  if (!stats.isFile() && !stats.isSymbolicLink()) return yield* new Stop({ reason: "special_file" })
  if (stats.size > BigInt(context.limits.entryBytes)) return { kind: "excluded", reason: "oversized" } satisfies Seen
  if (stats.isSymbolicLink()) {
    // A symlink's lstat size is its target length, so the read is reserved before readlink.
    yield* charge(budget, Number(stats.size))
    const target = yield* io(() => readlink(absolute, { encoding: "buffer" })).pipe(
      Effect.mapError(() => new Stop({ reason: "race" })),
    )
    const after = yield* io(() => lstat(absolute, { bigint: true })).pipe(
      Effect.mapError(() => new Stop({ reason: "race" })),
    )
    if (signature(after) !== signature(stats) || target.length !== Number(stats.size))
      return yield* new Stop({ reason: "race" })
    return { kind: "blob", mode: "120000", oid: blob([target]), sig: signature(stats) } satisfies Seen
  }
  return yield* readRegular(context, absolute, stats, budget)
})

const readRegular = (context: Run, absolute: string, before: BigIntStats, budget: Budget) =>
  Effect.acquireUseRelease(
    (context.seam ? context.seam({ phase: "open", path: absolute }) : Effect.void).pipe(
      Effect.andThen(io(() => open(absolute, READ_FLAGS))),
      Effect.map(Option.some),
      Effect.catch((error) =>
        error.code === "EACCES" || error.code === "EPERM"
          ? Effect.succeed(Option.none())
          : Effect.fail(new Stop({ reason: error.code === "ENOENT" || error.code === "ELOOP" ? "race" : "io" })),
      ),
    ),
    (handle) =>
      Effect.gen(function* () {
        if (Option.isNone(handle)) return { kind: "excluded", reason: "unreadable" } satisfies Seen
        const file = handle.value
        const opened = yield* io(() => file.stat({ bigint: true })).pipe(
          Effect.mapError(() => new Stop({ reason: "io" })),
        )
        // Refuse a raced swap (including to a FIFO or device) before reading any content.
        if (!opened.isFile() || signature(opened) !== signature(before)) return yield* new Stop({ reason: "race" })
        // Reserve the whole file before reading, then never request more than one byte past the
        // expected size: that byte only detects growth, so a pass reads at most limit + 1 per file.
        const size = Number(before.size)
        yield* charge(budget, size)
        const hasher = createHash("sha1")
        hasher.update(`blob ${size}\0`)
        const buffer = Buffer.alloc(CHUNK)
        const state = { total: 0 }
        while (true) {
          // The deadline is enforced inside the read loop; interruption lands between chunks.
          if (Date.now() >= context.deadline) return yield* new Stop({ reason: "timeout" })
          const read = yield* io(() => file.read(buffer, 0, Math.min(CHUNK, size - state.total + 1), null)).pipe(
            Effect.mapError(() => new Stop({ reason: "io" })),
          )
          if (read.bytesRead === 0) break
          if (context.seam) yield* context.seam({ phase: "chunk", path: absolute })
          state.total += read.bytesRead
          if (state.total > size) return yield* new Stop({ reason: "race" })
          hasher.update(buffer.subarray(0, read.bytesRead))
        }
        const after = yield* io(() => file.stat({ bigint: true })).pipe(
          Effect.mapError(() => new Stop({ reason: "io" })),
        )
        if (state.total !== size || signature(after) !== signature(before)) return yield* new Stop({ reason: "race" })
        return {
          kind: "blob",
          mode: before.mode & 0o100n ? "100755" : "100644",
          oid: hasher.digest("hex"),
          sig: signature(before),
        } satisfies Seen
      }),
    (handle) => (Option.isSome(handle) ? io(() => handle.value.close()).pipe(Effect.ignore) : Effect.void),
  )

const charge = (budget: Budget, bytes: number) =>
  Effect.suspend(() => {
    budget.read += bytes
    return budget.read > budget.limit ? Effect.fail(new Stop({ reason: budget.reason })) : Effect.void
  })

const parentKind = (absolute: string) =>
  io(() => lstat(absolute)).pipe(
    Effect.map((stats): "directory" | "symlink" | "absent" =>
      stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : "absent",
    ),
    Effect.catch((error) =>
      error.code === "ENOENT" || error.code === "ENOTDIR"
        ? Effect.succeed("absent" as const)
        : Effect.fail(new Stop({ reason: "io" })),
    ),
  )

interface Tree {
  readonly oid: string
  readonly containsSymlink: boolean
  readonly trees: ReadonlyMap<string, Tree>
}

/** Git-format tree IDs computed in process: no index, no object store, no blobs. */
function buildTree(seen: ReadonlyMap<string, Seen>): Tree {
  type Draft = { files: Map<string, { mode: string; oid: string }>; dirs: Map<string, Draft> }
  const root: Draft = { files: new Map(), dirs: new Map() }
  for (const [key, value] of seen) {
    if (value.kind !== "blob") continue
    const parts = key.split("/")
    const leaf = parts.pop()!
    const parent = parts.reduce((draft, part) => {
      const next = draft.dirs.get(part) ?? { files: new Map(), dirs: new Map() }
      draft.dirs.set(part, next)
      return next
    }, root)
    parent.files.set(leaf, { mode: value.mode, oid: value.oid })
  }
  const finish = (draft: Draft): Tree => {
    const trees = new Map([...draft.dirs].map(([name, child]) => [name, finish(child)]))
    const items = [
      ...[...draft.files].map(([name, file]) => ({ name, mode: file.mode, oid: file.oid, sort: name })),
      ...[...trees].map(([name, tree]) => ({ name, mode: "40000", oid: tree.oid, sort: name + "/" })),
    ].toSorted((a, b) => Buffer.compare(Buffer.from(a.sort, "latin1"), Buffer.from(b.sort, "latin1")))
    const body = Buffer.concat(
      items.flatMap((item) => [
        Buffer.from(`${item.mode} `, "latin1"),
        Buffer.from(item.name + "\0", "latin1"),
        Buffer.from(item.oid, "hex"),
      ]),
    )
    const hasher = createHash("sha1")
    hasher.update(`tree ${body.length}\0`)
    hasher.update(body)
    return {
      oid: hasher.digest("hex"),
      containsSymlink:
        [...draft.files.values()].some((file) => file.mode === "120000") ||
        [...trees.values()].some((tree) => tree.containsSymlink),
      trees,
    }
  }
  return finish(root)
}

const resolveAnchor = Effect.fnUntraced(function* (
  context: Run,
  anchor: string,
  pass: { readonly seen: ReadonlyMap<string, Seen>; readonly excluded: readonly string[]; readonly tree: Tree },
) {
  if (!canonical(anchor)) return { state: "unknown", reason: "noncanonical" } satisfies Anchor
  const key = Buffer.from(anchor, "utf8").toString("latin1")
  const parts = key.split("/")
  const ancestors = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
  const at = (name: string) => pass.seen.get(name)
  if ([key, ...ancestors].some((name) => at(name)?.kind === "excluded"))
    return { state: "unknown", reason: "excluded" } satisfies Anchor
  if (pass.excluded.some((name) => name.startsWith(key + "/")))
    return { state: "unknown", reason: "excluded" } satisfies Anchor
  if (
    ancestors.some((name) => {
      const value = at(name)
      return value?.kind === "blob" && value.mode === "120000"
    })
  )
    return { state: "unknown", reason: "symlink_parent" } satisfies Anchor
  const entry = at(key)
  if (entry?.kind === "blob") return { state: "entry", mode: entry.mode, oid: entry.oid } satisfies Anchor
  const tree = parts.reduce<Tree | undefined>((current, part) => current?.trees.get(part), pass.tree)
  if (tree) return { state: "tree", oid: tree.oid, containsSymlink: tree.containsSymlink } satisfies Anchor
  return yield* absence(context.repository.worktree + "/" + anchor)
})

/**
 * Literal absence needs ENOENT under a parent chain opened no-follow-anywhere: a symlink anywhere
 * in the parent chain is ELOOP. The leaf is only `lstat`ed, never opened, so a device node is
 * never touched. Case/Unicode aliases resolve to an existing entry and stay unknown.
 */
const absence = (absolute: string) =>
  Effect.acquireUseRelease(
    io(() => open(path.dirname(absolute), constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY)),
    () => io(() => lstat(absolute)),
    (handle) => io(() => handle.close()).pipe(Effect.ignore),
  ).pipe(
    Effect.as<Anchor>({ state: "unknown", reason: "outside_universe" }),
    Effect.catch((error) =>
      Effect.succeed<Anchor>(
        error.code === "ENOENT" || error.code === "ENOTDIR"
          ? { state: "absent" }
          : error.code === "ELOOP"
            ? { state: "unknown", reason: "symlink_parent" }
            : { state: "unknown", reason: "indeterminate" },
      ),
    ),
  )

const canonicalRepository = Effect.fnUntraced(function* (repository: Input["repository"]) {
  const resolve = (value: string) =>
    path.isAbsolute(value)
      ? io(() => realpath(value)).pipe(Effect.mapError(() => new Stop({ reason: "identity" })))
      : Effect.fail(new Stop({ reason: "identity" }))
  return {
    worktree: yield* resolve(repository.worktree),
    gitDirectory: yield* resolve(repository.gitDirectory),
    commonDirectory: yield* resolve(repository.commonDirectory),
  }
})

const identity = Effect.fnUntraced(function* (repository: Run["repository"]) {
  const worktree = yield* io(() => lstat(repository.worktree, { bigint: true })).pipe(
    Effect.mapError(() => new Stop({ reason: "identity" })),
  )
  const common = yield* io(() => lstat(repository.commonDirectory, { bigint: true })).pipe(
    Effect.mapError(() => new Stop({ reason: "identity" })),
  )
  if (!worktree.isDirectory() || !common.isDirectory()) return yield* new Stop({ reason: "identity" })
  return {
    worktree: { dev: Number(worktree.dev), ino: Number(worktree.ino) },
    common: { dev: Number(common.dev), ino: Number(common.ino), birthtime: Number(common.birthtimeMs) },
  } satisfies Identity
})

const signatureOf = (file: string) =>
  io(() => lstat(file, { bigint: true })).pipe(
    Effect.map(signature),
    Effect.catch((error) =>
      error.code === "ENOENT" || error.code === "ENOTDIR"
        ? Effect.succeed("absent")
        : Effect.fail(new Stop({ reason: "io" })),
    ),
  )

/** Fresh owner-only scratch per capture. It only ever holds empty HOME/XDG/hooks directories and a capability probe. */
const scratchDirectory = (scratch: string, maximum: number, reclaim: (scratch: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    yield* io(() => mkdir(scratch, { recursive: true, mode: 0o700 })).pipe(Effect.ignore)
    // A root that exists but is shared, foreign, a link or not a directory is refused as unsafe and
    // never repaired: chmod cannot undo earlier exposure or vouch for its contents. Failing to
    // create or inspect it at all is an ordinary filesystem error.
    const root = yield* rootState(scratch)
    if (root === "missing") return yield* new Stop({ reason: "io" })
    if (root === "unsafe") return yield* new Stop({ reason: "scratch_unsafe" })
    const count = () =>
      io(() => readdir(scratch)).pipe(
        Effect.map((names) => names.filter((name) => OWNER.test(name)).length),
        Effect.mapError(() => new Stop({ reason: "io" })),
      )
    if ((yield* count()) >= maximum) {
      yield* reclaim(scratch)
      if ((yield* count()) >= maximum) return yield* new Stop({ reason: "scratch_limit" })
    }
    // Register before creating, so a concurrent reclaim never treats a directory in setup as dead.
    const directory = path.join(scratch, `cap-${process.pid}-${randomUUID()}`)
    active.add(directory)
    yield* io(async () => {
      await mkdir(directory, { mode: 0o700 })
      await mkdir(path.join(directory, "home", "xdg"), { recursive: true, mode: 0o700 })
      await mkdir(path.join(directory, "hooks"), { mode: 0o700 })
    }).pipe(
      Effect.catch(() =>
        io(() => rm(directory, { recursive: true, force: true })).pipe(
          Effect.ignore,
          Effect.andThen(Effect.sync(() => active.delete(directory))),
          Effect.andThen(Effect.fail(new Stop({ reason: "io" }))),
        ),
      ),
    )
    return directory
  }).pipe(Effect.uninterruptible)

/**
 * Prove O_NOFOLLOW_ANY in this runtime: protected opens refuse an intermediate link, a plain open
 * follows it. Returns undefined when the probe itself could not run (e.g. ENOSPC), so a transient
 * failure is not cached as a permanent platform verdict.
 */
const probeCapability = (directory: string) =>
  io(async () => {
    const root = path.join(directory, "probe")
    await mkdir(path.join(root, "real"), { recursive: true, mode: 0o700 })
    await writeFile(path.join(root, "real", "file"), "probe")
    await symlink(path.join(root, "real"), path.join(root, "link"))
    const direct = await open(path.join(root, "real", "file"), READ_FLAGS)
    await direct.close()
    const plain = await open(path.join(root, "link", "file"), constants.O_RDONLY | constants.O_NONBLOCK)
    await plain.close()
    return open(path.join(root, "link", "file"), READ_FLAGS).then(
      async (handle) => {
        await handle.close()
        return false
      },
      // Only ELOOP is a definitive yes; EMFILE and similar say nothing about the kernel.
      (error: unknown): boolean | undefined => (errno(error) === "ELOOP" ? true : undefined),
    )
  }).pipe(
    Effect.map((value): boolean | undefined => value),
    Effect.catch((error) => Effect.succeed(error.code === "EINVAL" ? false : undefined)),
  )

/** The scratch root must be a real directory owned by this user and closed to others; never a link. */
const rootState = (scratch: string) =>
  io(() => lstat(scratch)).pipe(
    Effect.map((stats): "owned" | "unsafe" | "missing" =>
      stats.isDirectory() && !stats.isSymbolicLink() && stats.uid === process.getuid?.() && (stats.mode & 0o077) === 0
        ? "owned"
        : "unsafe",
    ),
    Effect.orElseSucceed(() => "missing" as const),
  )

function dead(name: string, directory: string) {
  const match = name.match(OWNER)
  if (!match) return false
  const pid = Number(match[1])
  if (pid === process.pid) return !active.has(directory)
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM means alive under another user: ownership is ambiguous, keep it.
    return errno(error) === "ESRCH"
  }
}

function io<A>(body: () => Promise<A>) {
  return Effect.tryPromise({ try: body, catch: (cause) => ({ code: errno(cause) }) })
}

function errno(cause: unknown) {
  return cause && typeof cause === "object" && "code" in cause ? String(cause.code) : undefined
}

function signature(stats: BigIntStats) {
  return `${stats.dev}:${stats.ino}:${stats.mode}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`
}

function blob(parts: readonly Buffer[]) {
  const hasher = createHash("sha1")
  hasher.update(`blob ${parts.reduce((total, part) => total + part.length, 0)}\0`)
  for (const part of parts) hasher.update(part)
  return hasher.digest("hex")
}

function decode(bytes: Buffer) {
  const text = bytes.toString("utf8")
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined
}

/** Case- and normalization-folded form of a latin1 key, for alias detection only. */
function folded(key: string) {
  const text = decode(Buffer.from(key, "latin1")) ?? key
  return text.normalize("NFD").toLowerCase()
}

function split(buffer: Buffer) {
  const records: Buffer[] = []
  let start = 0
  for (let index = buffer.indexOf(0); index !== -1; index = buffer.indexOf(0, start)) {
    if (index > start) records.push(buffer.subarray(start, index))
    start = index + 1
  }
  return records
}

function sameUniverse(a: Universe, b: Universe) {
  return (
    a.size === b.size &&
    [...a].every(([key, value]) => {
      const other = b.get(key)
      return other !== undefined && other.gitlink === value.gitlink && other.embedded === value.embedded
    })
  )
}

function sameSeen(a: ReadonlyMap<string, Seen>, b: ReadonlyMap<string, Seen>) {
  return a.size === b.size && [...a].every(([key, value]) => JSON.stringify(b.get(key)) === JSON.stringify(value))
}
