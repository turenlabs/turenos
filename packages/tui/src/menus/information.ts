import { TextRenderable } from "@opentui/core"
import { display } from "../messages"
import { label, sessionTitle, type DashboardState } from "../state"
import { color } from "../theme"
import { stamp } from "./stamp"
import type { MenuContext } from "./context"

type Snapshot = NonNullable<DashboardState["snapshot"]>
type Session = Snapshot["sessions"][number]
type Detail = NonNullable<DashboardState["detail"]>

export function information(ctx: MenuContext, address: string) {
  const { state } = ctx
  const dialog = ctx.dialogs.open("Details", false, 26)
  if (!dialog) return
  const snapshot = state.snapshot
  const session = state.tab === "sessions" ? snapshot?.sessions.find((item) => item.id === state.selected) : undefined
  const result = state.detail?.sessionID === session?.id ? state.detail : undefined
  const tasks = new Map([...(result?.tasks.data ?? []), ...(result?.tasks.active ?? [])].map((task) => [task.id, task]))
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: [
        session ? `SESSION\n${display(sessionLines(session, result).join("\n"), 6000)}` : "",
        tasks.size ? taskLines(tasks.values()) : "",
        snapshot ? snapshotLines(snapshot, state.connected, session?.location.directory) : "",
        `SERVER\n${label(serverAddress(address), 1000)}\n${state.connected ? "Connected" : state.connectionError || "Connecting…"}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      fg: color.text,
      wrapMode: "word",
    }),
  )
  dialog.error.content = "PgUp/PgDn scroll · Esc close"
  dialog.form.focus()
}

/** The address arrives as "host:port · url"; when the URL already holds the host, only the URL is shown. */
function serverAddress(address: string) {
  const [host, url] = address.split(" · ")
  return url?.includes(host!) ? url : address
}

function sessionLines(session: Session, result: Detail | undefined) {
  // The footer shows the same fallback: what the latest reply actually ran with.
  const reply = result?.messages.findLast((message) => message.type === "assistant")
  const model =
    session.model ??
    (reply && (reply.model.providerID !== "unknown" || reply.model.id !== "unknown") ? reply.model : undefined)
  const modelStr = model
    ? `${model.providerID}/${model.id}${model.variant ? ` (${model.variant})` : ""}`
    : "server default"
  return [
    sessionTitle(session.title || "Untitled session", 200),
    ...(session.time.archived !== undefined ? ["Archived · Ctrl+P restore brings it back to the lists"] : []),
    `Session ID: ${session.id}`,
    ...(session.parentID ? [`Parent ID: ${session.parentID}`] : []),
    `Directory: ${session.location.directory}`,
    `Agent: ${session.agent ?? reply?.agent ?? "server default"} · Model: ${modelStr}`,
    `Created: ${stamp(session.time.created)}`,
    ...(session.time.updated ? [`Updated: ${stamp(session.time.updated)}`] : []),
    ...(session.tokens ? [tokenLine(session)] : []),
    ...(result
      ? [
          `${result.permissions.length} permissions · ${result.questions.length} questions · ${result.pending.length} queued inputs`,
        ]
      : []),
  ]
}

function tokenLine(session: Session) {
  const t = session.tokens!
  const tokenParts = [`in: ${t.input.toLocaleString()}`, `out: ${t.output.toLocaleString()}`]
  if (t.reasoning) tokenParts.push(`reasoning: ${t.reasoning.toLocaleString()}`)
  if (t.cache?.read || t.cache?.write)
    tokenParts.push(`cache: ${t.cache.read.toLocaleString()}r/${t.cache.write.toLocaleString()}w`)
  return `Tokens: ${tokenParts.join(" · ")}${session.cost ? ` · Cost: $${session.cost.toFixed(4)}` : ""}`
}

function taskLines(tasks: Iterable<Detail["tasks"]["data"][number]>) {
  return display(
    `DELEGATED TASKS\n${[...tasks].map((task) => `[${task.status}] ${display(task.description, 500)}\n${task.agent} · ${task.childSessionID}${task.error ? `\n${display(task.error, 1000)}` : ""}`).join("\n")}`,
    8000,
  )
}

/** The project's inventory; its folder is left out when the session block above already shows it. */
function snapshotLines(snapshot: Snapshot, connected: boolean, sessionDirectory: string | undefined) {
  const directory = snapshot.location.directory === sessionDirectory ? [] : [label(snapshot.location.directory, 4096)]
  const terminals = snapshot.inventoryErrors.terminals
    ? `Terminal inventory unavailable: ${snapshot.inventoryErrors.terminals}`
    : snapshot.terminalsAvailable
      ? `${snapshot.terminals.length} managed terminals${snapshot.terminalFolderErrors.length ? ` (unavailable in ${snapshot.terminalFolderErrors.map((item) => label(item.directory, 4096)).join(", ")})` : ""}`
      : "Terminal inventory unavailable on this server version"
  return [
    "PROJECT",
    ...directory,
    `Updated: ${stamp(snapshot.updated)}${connected ? "" : " (stale)"}`,
    `${Object.keys(snapshot.active).length}${snapshot.activeOmitted ? ` (+${snapshot.activeOmitted} not shown)` : ""} running agents${snapshot.needsInput ? ` · ${snapshot.needsInput.length} need input` : ""}`,
    terminals,
    ...(snapshot.inventoryErrors.automations
      ? [`Automations unavailable: ${snapshot.inventoryErrors.automations}`]
      : []),
  ].join("\n")
}
