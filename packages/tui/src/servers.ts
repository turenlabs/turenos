import { homedir } from "node:os"
import { join } from "node:path"
import { preferred, scan } from "./servers/discovery"
import { readProc } from "./servers/listener"
import { trustedRecord } from "./servers/records"
import { resolve } from "./servers/resolve"
import { add, importDesktop, load, remove } from "./servers/saved"
import type { Context, Options, State, Target } from "./servers/types"

export { PasswordRequired } from "./servers/types"
export type { Endpoint, Entry, Group, Target } from "./servers/types"
export { parseSshTarget, serverLabel, sshDestination } from "./servers/targets"

export function createServers(options: Options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const ctx: Context = {
    env,
    home,
    platform,
    // An explicit undefined skips ownership checks, as on Windows.
    uid: "uid" in options ? options.uid : process.getuid?.(),
    configPath: options.config ?? join(env.XDG_CONFIG_HOME || join(home, ".config"), "turen-tui", "servers.json"),
    ssh: options.ssh ?? env.TURENOS_SSH ?? (platform === "win32" ? "ssh.exe" : "ssh"),
    persistentPath: options.persistentRecord ?? "/etc/turenos/attach.json",
    forge: options.forge,
    username: options.username,
    readProc: options.readProc ?? readProc,
  }
  const state: State = {
    passwords: new Map(),
    saved: [],
    problems: [],
    notes: [],
    unwritable: undefined,
    preserved: [],
    imported: [],
    headless: undefined,
  }
  return {
    configPath: ctx.configPath,
    /** Saved-server errors and discovery notes worth showing beside the list. */
    problems: () => [...state.problems, ...state.notes],
    load: () => load(ctx, state),
    scan: () => scan(ctx, state),
    preferred: () => preferred(ctx, state),
    /** Whether a local server's owner published a record for exactly this origin. */
    trusts: async (origin: string) => !!(await trustedRecord(ctx, origin)),
    resolve: (target: Target, input?: Parameters<typeof resolve>[3]) => resolve(ctx, state, target, input),
    importDesktop: (endpoint: Parameters<typeof importDesktop>[1]) => importDesktop(state, endpoint),
    remember: (target: Target, password: string) => state.passwords.set(target.id, password),
    forget: (target: Target) => state.passwords.delete(target.id),
    find: (name: string) =>
      state.saved.find((target) => target.name === name || target.id === name) ??
      state.imported.find((target) => target.name === name),
    add: (input: { address: string; name?: string; username?: string }) => add(ctx, state, input),
    remove: (target: Target) => remove(ctx, state, target),
    stopHeadless() {
      state.headless?.child.kill()
      state.headless = undefined
    },
  }
}

export type Servers = ReturnType<typeof createServers>
