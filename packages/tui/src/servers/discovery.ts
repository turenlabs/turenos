import { join } from "node:path"
import { envListener } from "./listener"
import { APPS, appData, desktopRecord, desktopRunning, forgeBinary, persistentRecord, shimRecord } from "./records"
import { shortPath } from "./text"
import { sshAddress } from "./targets"
import type { Context, Entry, State } from "./types"

const ENV_NOTES = {
  unchecked: "FORGE_SERVER_PASSWORD",
  unknown: "FORGE_SERVER_PASSWORD · owner unknown",
  none: "not listening",
  foreign: "owned by another user",
  own: "FORGE_SERVER_PASSWORD",
}

/** Every server this client can offer: local records, saved servers, then the desktop's SSH servers. */
export async function scan(ctx: Context, state: State): Promise<Entry[]> {
  const local = await localEntries(ctx, state)
  const destinations = new Set(state.saved.flatMap((target) => (target.kind === "ssh" ? [sshAddress(target)] : [])))
  return [
    ...local,
    ...state.saved.map((target) => ({
      target,
      group: "Saved" as const,
      detail: target.kind === "url" ? target.url : `ssh ${sshAddress(target)}`,
    })),
    ...state.imported
      .filter((target) => !destinations.has(sshAddress(target)))
      .map((target) => ({
        target,
        group: "From TurenOS Desktop" as const,
        detail: `ssh ${sshAddress(target)}`,
      })),
  ]
}

/**
 * The local server to open without asking: desktop first, then this host's own servers. Port 4096 is
 * chosen for the user only where its listener's owner can be checked (Linux); elsewhere the user picks it.
 */
export async function preferred(ctx: Context, state: State) {
  return (await scan(ctx, state)).find(
    (entry) =>
      entry.group === "This computer" &&
      entry.target.kind !== "headless" &&
      (entry.target.kind !== "env" || ctx.platform === "linux"),
  )?.target
}

async function localEntries(ctx: Context, state: State) {
  const local: Entry[] = []
  const root = appData(ctx)
  state.notes = []
  for (const [appId, name] of APPS) {
    const record = root ? join(root, appId, "attach.json") : undefined
    const found = record ? await desktopRecord(ctx, record) : undefined
    if (record && found)
      local.push({
        target: { kind: "desktop", id: `desktop:${appId}`, name, record },
        group: "This computer",
        detail: `Desktop app · port ${new URL(found.url).port}`,
        url: found.url,
      })
    else if (await desktopRunning(ctx, appId))
      state.notes.push(`${name} is running but does not publish its server. Update it to connect from here.`)
  }
  const shim = await shimRecord(ctx)
  if (shim)
    local.push({
      target: { kind: "shim", id: "shim", name: "Quick-connect server" },
      group: "This computer",
      detail: "Started by TurenOS Desktop over SSH · ~/.forge/run",
      url: shim.url,
    })
  const persistent = ctx.platform === "linux" ? await persistentRecord(ctx).catch(() => undefined) : undefined
  if (persistent)
    local.push({
      target: { kind: "persistent", id: "persistent", name: "Persistent server" },
      group: "This computer",
      detail: "turenos.service · /etc/turenos/attach.json",
      url: persistent.url,
    })
  // TurenOS exports its own sidecar's password to every shell it starts, and that sidecar is not on 4096.
  if (ctx.env.FORGE_SERVER_PASSWORD !== undefined && ctx.env.FORGE_CLIENT !== "desktop")
    local.push({
      target: { kind: "env", id: "env", name: "Headless server on port 4096", url: "http://127.0.0.1:4096" },
      group: "This computer",
      detail: `127.0.0.1:4096 · ${ENV_NOTES[envListener(ctx)]}`,
      url: "http://127.0.0.1:4096",
    })
  const binary = forgeBinary(ctx)
  if (binary) local.push(headlessEntry(ctx, state, binary))
  else if (ctx.forge === undefined && ctx.env.TURENOS_FORGE)
    state.notes.push("TURENOS_FORGE must be the absolute path of an executable file.")
  return local
}

function headlessEntry(ctx: Context, state: State, binary: string): Entry {
  return {
    target: {
      kind: "headless",
      id: "headless",
      name: state.headless ? "Private server" : "Start a private server",
      binary,
    },
    group: "This computer",
    detail: state.headless
      ? `Running · port ${new URL(state.headless.url).port} · stops when you quit`
      : `forge serve from ${shortPath(binary, ctx.home)} · stops when you quit`,
  }
}
