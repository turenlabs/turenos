import { TextRenderable } from "@opentui/core"
import { display } from "../messages"
import { label, type DashboardState } from "../state"
import { color } from "../theme"
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
  const sessionMeta = session ? sessionLines(session) : []
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: [
        sessionMeta.length ? display(sessionMeta.join("\n"), 6000) : "",
        result
          ? `${result.permissions.length} permissions · ${result.questions.length} questions · ${result.pending.length} queued inputs`
          : "",
        tasks.size ? taskLines(tasks.values()) : "",
        `SERVER\n${label(address, 1000)}\n${state.connected ? "Connected" : state.connectionError || "Connecting…"}`,
        snapshot ? snapshotLines(snapshot, state.connected) : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      fg: color.text,
      wrapMode: "word",
    }),
  )
  dialog.error.content = "Page Up / Down scroll · Esc close"
  dialog.form.focus()
}

function sessionLines(session: Session) {
  const modelStr = session.model
    ? `${session.model.providerID}/${session.model.id}${session.model.variant ? ` (${session.model.variant})` : ""}`
    : "server default"
  const lines = [
    label(session.title || "Untitled session", 200),
    `Session ID: ${session.id}`,
    ...(session.parentID ? [`Parent ID: ${session.parentID}`] : []),
    `Directory: ${session.location.directory}`,
    `Agent: ${session.agent ?? "server default"}`,
    `Model: ${modelStr}`,
  ]
  if (session.time) {
    lines.push(
      `Created: ${new Date(session.time.created).toLocaleString()}` +
        (session.time.updated ? ` · Updated: ${new Date(session.time.updated).toLocaleString()}` : ""),
    )
  }
  if (session.tokens) lines.push(tokenLine(session))
  return lines
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

function snapshotLines(snapshot: Snapshot, connected: boolean) {
  return `${label(snapshot.location.directory, 4096)}\nUpdated ${new Date(snapshot.updated).toLocaleString()}${connected ? "" : " (stale)"}\n${Object.keys(snapshot.active).length} running agents\n${snapshot.inventoryErrors.terminals ? `Terminal inventory unavailable: ${snapshot.inventoryErrors.terminals}` : snapshot.terminalsAvailable ? `${snapshot.terminals.length} managed terminals` : "Terminal inventory unavailable on this server version"}${snapshot.inventoryErrors.automations ? `\nAutomations unavailable: ${snapshot.inventoryErrors.automations}` : ""}`
}
