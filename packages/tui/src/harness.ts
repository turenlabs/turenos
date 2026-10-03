import { SelectRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { SessionsStateOutput } from "@turenlabs/client"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { display } from "./messages"
import { errorText, type Connection, type Session } from "./server"
import { label, type DashboardState } from "./state"
import { color } from "./theme"

type State = SessionsStateOutput
type Proposal = State["proposals"][number]
type Action =
  | { kind: "approve" | "apply" | "reject"; proposal: Proposal }
  | { kind: "reload"; version: number }
  | { kind: "rollback"; version: number }

/**
 * The session harness the server runs for every session: its active snapshot (tools and standing
 * guidance), the automatic reviewer's runs, and the proposals it made. Opening it is read-only;
 * each change is a separate confirmation, like the desktop's Harness panel.
 */
export function createHarnessControls(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  blocked: (id: string) => boolean,
) {
  function selected() {
    return state.tab === "sessions" ? state.snapshot?.sessions.find((item) => item.id === state.selected) : undefined
  }

  function overview(session: Session) {
    const opened = dialogs.open("Harness", false, 34)
    if (!opened) return
    const dialog = opened
    dialog.recipient = session
    const text = new TextRenderable(renderer, { content: "Loading harness (read-only)…", fg: color.text })
    dialog.form.add(text)
    const choices = new SelectRenderable(renderer, {
      height: 4,
      flexShrink: 0,
      options: [],
      showDescription: false,
      showSelectionIndicator: true,
      backgroundColor: color.panel,
      textColor: color.text,
      selectedBackgroundColor: color.selected,
      selectedTextColor: color.accent,
    })
    dialog.frame.add(choices, dialog.frame.getChildren().indexOf(dialog.error))
    dialogs.track(dialog, choices)
    let actions: Action[] = []
    let request = 0
    async function refresh() {
      const version = ++request
      try {
        const harness = await connection.client.sessions.state({ sessionID: session.id })
        if (version !== request || state.modal !== dialog) return
        actions = blocked(session.id) ? [] : available(harness)
        choices.options = actions.map((action) => ({ name: title(action), description: "" }))
        choices.visible = actions.length > 0
        text.content = describe(session, harness)
        dialog.error.content = `${actions.length ? "Enter chooses a change to confirm · " : ""}Ctrl+R refresh · Esc close${blocked(session.id) ? "\nTask-owned session: read-only." : ""}`
      } catch (error) {
        if (version !== request || state.modal !== dialog) return
        actions = []
        choices.visible = false
        text.content = `Harness unavailable: ${errorText(error)}`
        dialog.error.content = "Ctrl+R retry · Esc close"
      }
    }
    dialog.refresh = () => void refresh()
    dialog.key = (key) => {
      if (matchesKey(key, "r", { ctrl: true })) {
        void refresh()
        return true
      }
      if (!matchesKey(key, "enter")) return false
      const action = actions[choices.getSelectedIndex()]
      if (!action) return true
      dialogs.close(false)
      confirm(session, action)
      return true
    }
    choices.focus()
    void refresh()
  }

  function confirm(session: Session, action: Action) {
    const dialog = dialogs.open(`${title(action).split(":")[0]}?`, false, 34)
    if (!dialog) return
    dialog.recipient = session
    dialog.frame.add(
      new TextRenderable(renderer, {
        content:
          action.kind === "reject"
            ? "Confirm rejects this proposal; the active harness is unchanged."
            : action.kind === "reload" || action.kind === "rollback"
              ? "Confirm replaces the harness this session's agent runs with on its next turn."
              : "Confirm changes the tools and guidance this session's agent runs with on its next turn.",
        fg: action.kind === "reject" ? color.warning : color.error,
        height: 1,
        flexShrink: 0,
      }),
      0,
    )
    dialog.form.add(
      new TextRenderable(renderer, {
        content: `For: ${label(session.title || session.id, 100)}\n\n${"proposal" in action ? proposalText(action.proposal) : action.kind === "rollback" ? `Restore snapshot v${action.version - 1} over v${action.version}.` : `Reload snapshot v${action.version} from its declared sources.`}`,
        fg: color.text,
      }),
    )
    dialog.error.content = "Ctrl+S confirms · Esc back; nothing changed yet."
    dialog.back = () => overview(session)
    dialog.key = (key) => matchesKey(key, "enter")
    // After an uncertain result, retries only read state: a repeated write could apply twice.
    let attempted = false
    dialog.submit = async () => {
      if (blocked(session.id)) throw new Error("Task-owned session: use its owning session. Nothing changed.")
      const harness = await connection.client.sessions.state({ sessionID: session.id })
      if (state.modal !== dialog) return
      if (done(action, harness)) {
        say(attempted ? "Harness change observed." : "Already done; nothing changed.")
        return
      }
      if (attempted) throw new Error("Outcome unconfirmed. Retry only rechecks; Esc to review the harness.")
      if (!still(action, harness)) throw new Error("The harness changed. Esc to review it again; nothing was sent.")
      attempted = true
      try {
        await apply(session.id, action, harness)
      } catch (error) {
        throw new Error(`Outcome unconfirmed: ${errorText(error)}. Retry rechecks without resending.`)
      }
      say(
        action.kind === "reject"
          ? "Proposal rejected."
          : action.kind === "rollback"
            ? `Harness rolled back to v${action.version - 1}.`
            : action.kind === "reload"
              ? "Harness reloaded."
              : "Proposal applied. The agent uses it from its next turn.",
      )
    }
  }

  async function apply(sessionID: string, action: Action, harness: State) {
    if (action.kind === "reload") return connection.client.sessions.reload({ sessionID, baseVersion: action.version })
    if (action.kind === "rollback")
      return connection.client.sessions.rollback({
        sessionID,
        baseVersion: action.version,
        version: action.version - 1,
      })
    const proposalID = action.proposal.id
    if (action.kind === "reject") return connection.client.sessions.proposalReject({ sessionID, proposalID })
    // Approval and application are separate server steps; an approved proposal only needs applying.
    if (harness.proposals.find((item) => item.id === proposalID)?.status !== "approved")
      await connection.client.sessions.proposalStatus({ sessionID, proposalID, status: "approved" })
    return connection.client.sessions.proposalApply({ sessionID, proposalID })
  }

  return {
    open() {
      const session = selected()
      if (!session) return say("Select a created session first.", true)
      if (state.closed || !dialogs.navigate()) return
      if (!state.connected) return say("Reconnect before opening the harness.", true)
      overview(structuredClone(session))
    },
  }
}

function available(harness: State): Action[] {
  return [
    ...harness.proposals.flatMap((proposal): Action[] =>
      proposal.status === "approved"
        ? [
            { kind: "apply", proposal },
            { kind: "reject", proposal },
          ]
        : proposal.status === "pending" || proposal.status === "draft"
          ? [
              { kind: "approve", proposal },
              { kind: "reject", proposal },
            ]
          : [],
    ),
    ...(harness.snapshot ? [{ kind: "reload" as const, version: harness.snapshot.version }] : []),
    ...(harness.snapshot && harness.snapshot.version > 1
      ? [{ kind: "rollback" as const, version: harness.snapshot.version }]
      : []),
  ]
}

function title(action: Action) {
  if (action.kind === "reload") return `Reload harness (v${action.version})`
  if (action.kind === "rollback") return `Roll back to v${action.version - 1}`
  const verb = action.kind === "approve" ? "Approve and apply" : action.kind === "apply" ? "Apply" : "Reject"
  return `${verb}: ${label(action.proposal.summary, 80)}`
}

/** True once the server shows the outcome the action asked for. */
function done(action: Action, harness: State) {
  if ("proposal" in action) {
    const status = harness.proposals.find((item) => item.id === action.proposal.id)?.status
    return action.kind === "reject" ? status === "rejected" : status === "applied"
  }
  return !!harness.snapshot && harness.snapshot.version > action.version && harness.snapshot.source === action.kind
}

/** True while the harness is still in the state the user reviewed. */
function still(action: Action, harness: State) {
  if ("proposal" in action)
    return ["draft", "pending", "approved"].includes(
      harness.proposals.find((item) => item.id === action.proposal.id)?.status ?? "",
    )
  return harness.snapshot?.version === action.version
}

function describe(session: Session, harness: State) {
  const snapshot = harness.snapshot
  const runs = harness.reviewerRuns.toSorted((a, b) => b.timestamp - a.timestamp)
  const counts = Object.entries(
    Object.groupBy(harness.proposals, (proposal) => proposal.status) as Record<string, Proposal[]>,
  ).map(([status, items]) => `${items.length} ${status}`)
  return display(
    [
      `For: ${label(session.title || session.id, 100)}`,
      snapshot
        ? `Snapshot v${snapshot.version} · ${snapshot.status} · from ${snapshot.source} · validation ${snapshot.validation.status}`
        : "No harness snapshot yet.",
      ...(snapshot?.validation.errors.length ? [`Errors: ${snapshot.validation.errors.join("; ")}`] : []),
      "",
      `TOOLS (${snapshot?.tools.length ?? 0})`,
      ...(snapshot?.tools.map(toolLine) ?? []),
      `GUIDANCE (${snapshot?.guidance?.length ?? 0})`,
      ...(snapshot?.guidance?.map(guidanceLine) ?? []),
      "",
      `PROPOSALS${counts.length ? ` · ${counts.join(" · ")}` : " · none yet"}`,
      ...harness.proposals
        .toSorted((a, b) => b.timestamps.created - a.timestamps.created)
        .slice(0, 8)
        .map((proposal) => `  [${proposal.status}] ${label(proposal.summary, 200)}`),
      "",
      `REVIEWER · ${runs.length ? `${runs.length} recent runs` : "no runs yet"}`,
      ...runs
        .slice(0, 5)
        .map(
          (run) =>
            `  ${new Date(run.timestamp).toLocaleString()} · ${run.outcome.replaceAll("_", " ")}${run.detail ? ` — ${label(run.detail, 200)}` : ""}`,
        ),
    ].join("\n"),
    16000,
  )
}

function proposalText(proposal: Proposal) {
  return display(
    [
      label(proposal.summary, 1000),
      `Against v${proposal.baseVersion} · ${proposal.status} · validation ${proposal.validation.status}`,
      ...proposal.validation.errors.map((error) => `  ! ${label(error, 300)}`),
      ...proposal.validation.warnings.map((warning) => `  ~ ${label(warning, 300)}`),
      ...(proposal.changes.length ? ["", `CHANGES (${proposal.changes.length})`] : []),
      ...proposal.changes
        .slice(0, 20)
        .map(
          (change) =>
            `  ${change.operation} ${label(change.path, 200)}${change.summary ? ` — ${label(change.summary, 200)}` : ""}`,
        ),
      ...(proposal.tools?.length ? ["", `TOOLS (${proposal.tools.length})`] : []),
      ...(proposal.tools ?? []).map(toolLine),
      ...(proposal.guidance?.length ? ["", `GUIDANCE (${proposal.guidance.length})`] : []),
      ...(proposal.guidance ?? []).map(guidanceLine),
    ].join("\n"),
    16000,
  )
}

function toolLine(tool: NonNullable<Proposal["tools"]>[number]) {
  return `  ${label(tool.name, 64)}${tool.readOnly ? " · read-only" : ""}${tool.enabled ? "" : " · disabled"} — ${label(tool.description, 200)}`
}

function guidanceLine(item: NonNullable<Proposal["guidance"]>[number]) {
  return `  • ${label(item.directive, 300)}${item.appliesTo ? ` (${label(item.appliesTo, 120)})` : ""}`
}
