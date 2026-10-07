import { outsideNotice } from "../mentions/outside"
import { errorText } from "../server"
import { folderContains } from "../working-folders"
import type { LaunchForm } from "./context"
import { loadAgents } from "./agents"
import { saveDraft } from "./draft"

/** Sends the draft. A retry skips preparation so its frozen session ID, worktree and recipient stay as they were. */
export async function submitLaunch(form: LaunchForm) {
  const { state, openSession, say } = form.deps
  const { current, dialog } = form
  if (!state.connected) throw new Error("Reconnect before sending. Your draft is kept.")
  if (!current.start.input()) {
    if (form.task.plainText.trim().startsWith("!"))
      throw new Error("Shell commands run in an existing session: start the session, then send !command.")
    const notice = outsideNotice(form.task.plainText, form.directory.value.trim(), form.outsideAck)
    form.outsideAck = notice.key
    if (notice.message) throw new Error(notice.message)
    await prepare(form)
  }
  state.sentMessages.add(current.start.messageID)
  const session = await current
    .start({
      directory: current.directory,
      agent: current.agent,
      model: current.model || undefined,
      ...(current.variant !== undefined ? { variant: current.variant } : {}),
      prompt: current.prompt,
    })
    .finally(async () => {
      // A refused prompt unfreezes the draft, but the session it was created for still exists and must stay reachable.
      const exists = () =>
        form.deps.connection.client.sessions.get({ sessionID: current.start.sessionID }).then(
          () => true,
          () => false,
        )
      dialog.reference = current.start.input() || (await exists()) ? current.start.sessionID : undefined
    })
  form.store.defaults = {
    directory: current.directory,
    agent: current.agent,
    model: current.model,
    variant: current.variant,
  }
  form.store.draft = undefined
  form.store.settings = undefined
  if (state.closed) return
  const folderError = await syncFolder(form)
  openSession(session.id, false, session)
  say(`Task sent. The session is open.${folderError ? ` ${folderError}` : ""}`, !!folderError)
}

async function prepare(form: LaunchForm) {
  if (form.workspace.getSelectedIndex() === 1 && !form.current.worktree?.directory) await prepareWorktree(form)
  await loadAgents(form)
  if (form.loaded !== form.directory.value.trim())
    throw form.loadError ?? new Error("Cannot load this directory's agents. Check Directory and retry.")
  saveDraft(form)
}

async function prepareWorktree(form: LaunchForm) {
  const { current, dialog, directory } = form
  // One name per draft: a retry finds the worktree an uncertain attempt made instead of adding one.
  const worktree = (current.worktree ??= { name: `tui-${crypto.randomUUID().slice(0, 8)}`, attempted: false })
  const retry = worktree.attempted
  worktree.attempted = true
  dialog.error.content = "Preparing a new git worktree on the server…\nEsc stops waiting and keeps the draft."
  const stop = new AbortController()
  form.preparing = stop
  const cancelled = new Promise<never>((_, reject) =>
    stop.signal.addEventListener("abort", () =>
      reject(
        new Error("Stopped waiting for the worktree. Your draft is kept; Ctrl+S reuses the worktree if it finished."),
      ),
    ),
  )
  // The server keeps preparing after Esc; the same name lets the next send find that worktree.
  const result = await Promise.race([
    form.deps.connection.worktree(directory.value.trim(), worktree.name, retry, stop.signal),
    cancelled,
  ]).finally(() => {
    form.preparing = undefined
  })
  if (result.status === "failed") {
    current.worktree = undefined
    throw new Error(
      `The server could not prepare the worktree${result.message ? `: ${result.message}` : ""}. Ctrl+S tries a new one.`,
    )
  }
  worktree.directory = result.directory
  directory.value = result.directory
  form.deps.say(`Worktree ${worktree.name} is ready.`)
}

async function syncFolder(form: LaunchForm) {
  const { state, connection } = form.deps
  let folderError = ""
  if (
    state.snapshot?.workingFolders !== undefined &&
    !state.snapshot.workingFolders.some((folder) => folderContains(folder, form.current.directory))
  )
    await connection.folders.open(form.current.directory).catch((error) => {
      folderError = `Folder sync failed: ${errorText(error)}`
    })
  return folderError
}
