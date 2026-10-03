import { RenderableEvents, SelectRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import { errorText, type Connection, type Session } from "./server"
import { label, type DashboardState, type LaunchDraft } from "./state"
import { color } from "./theme"
import { folderContains } from "./working-folders"
import { turenLogo } from "./logo"
import type { Dialogs } from "./dialogs"
import type { Models } from "./models"
import { matchesKey } from "./keys"
import type { SlashCommands } from "./slash"
import type { ModelVariants } from "./model-variants"
import type { Mentions } from "./mentions"

export function createLaunch(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  openSession: (id: string, inspect?: boolean, session?: Session) => void,
  models: Models,
  slash: SlashCommands,
  variants: ModelVariants,
  mentions: Mentions,
) {
  let draft: LaunchDraft | undefined
  let defaults: Pick<LaunchDraft, "directory" | "agent" | "model" | "variant"> | undefined

  function open() {
    if (!dialogs.navigate()) return
    const snapshot = state.snapshot
    if (!snapshot || (!state.connected && !draft)) return say("Connect to the server before launching an agent.", true)
    const dialog = dialogs.open("New session", true)
    if (!dialog) return
    const directoryName =
      state.workingDirectory ??
      snapshot.sessions.find((session) => session.id === state.selected)?.location.directory ??
      snapshot.location.directory
    draft ??= {
      directory: directoryName,
      agent: defaults?.directory === directoryName ? defaults.agent : undefined,
      model: defaults?.directory === directoryName ? defaults.model : "",
      variant: defaults?.directory === directoryName ? defaults.variant : undefined,
      prompt: "",
      start: connection.launch(),
    }
    const current = draft
    const submitted = current.start.input()
    if (submitted) Object.assign(current, submitted, { model: submitted.model ?? "" })
    // Keep the prompt usable alongside the compact mark on small terminals.
    dialog.frame.gap = 0
    let settingsOpen = false
    const logo = new TextRenderable(renderer, {
      id: "turen-logo",
      ...turenLogo(renderer.width >= 100 && renderer.height >= 32),
      alignSelf: "center",
      flexShrink: 0,
      wrapMode: "none",
    })
    const resizeLogo = () => {
      if (state.closed || state.modal !== dialog || logo.isDestroyed) return
      Object.assign(
        logo,
        turenLogo(
          renderer.width >= 100 &&
            renderer.height >= 32 &&
            !settingsOpen &&
            !dialog.reference &&
            dialog.error.height <= 2,
        ),
      )
    }
    renderer.on("resize", resizeLogo)
    dialog.error.on("resize", resizeLogo)
    logo.once(RenderableEvents.DESTROYED, () => {
      renderer.off("resize", resizeLogo)
      dialog.error.off("resize", resizeLogo)
    })
    const context = new TextRenderable(renderer, {
      content: "",
      fg: color.text,
      height: 2,
      flexShrink: 0,
      wrapMode: "none",
      truncate: true,
      onMouseDown: (event) => {
        if (event.button !== 0 || dialog.busy) return
        event.preventDefault()
        dialog.settings?.()
        directory.focus()
        dialogs.reveal(dialog, directory)
      },
    })
    dialog.frame.add(context, 0)
    dialog.frame.add(logo, 0)
    const task = dialogs.prompt(dialog, "What would you like to do?", current.prompt, current.cursor)
    dialog.editorLocked = () => !!current.start.input()
    const directory = dialogs.input(dialog, "Directory on the server", current.directory)
    dialog.form.add(new TextRenderable(renderer, { content: "Agent · ↑/↓ to choose", fg: color.muted }))
    const agent = new SelectRenderable(renderer, {
      height: 3,
      marginBottom: 1,
      options: [
        { name: "Server default", description: "" },
        ...(current.agent ? [{ name: label(current.agent), description: "" }] : []),
      ],
      backgroundColor: color.bg,
      textColor: color.text,
      descriptionColor: color.muted,
      selectedBackgroundColor: color.selected,
      selectedTextColor: color.accent,
      showDescription: false,
    })
    dialog.form.add(agent)
    dialogs.track(dialog, agent)
    const model = dialogs.input(
      dialog,
      "Model · Ctrl+L browse, or enter provider/model",
      current.model,
      "Use server default",
    )
    dialog.form.add(new TextRenderable(renderer, { content: "Workspace · ↑/↓ to choose", fg: color.muted }))
    // The desktop's "New workspace": the session works in its own git worktree, off the main checkout.
    const workspace = new SelectRenderable(renderer, {
      height: 2,
      marginBottom: 1,
      options: [
        { name: "This folder", description: "" },
        { name: "New git worktree", description: "" },
      ],
      backgroundColor: color.bg,
      textColor: color.text,
      selectedBackgroundColor: color.selected,
      selectedTextColor: color.accent,
      showDescription: false,
    })
    workspace.setSelectedIndex(current.isolate ? 1 : 0)
    dialog.form.add(workspace)
    dialogs.track(dialog, workspace)
    const settings = dialog.form.getChildren().slice(2)
    settings.forEach((field) => {
      field.visible = false
    })
    dialog.settings = () => {
      settingsOpen = true
      resizeLogo()
      settings.forEach((field) => {
        field.visible = true
      })
    }
    let choices = current.agent ? [current.agent] : []
    agent.setSelectedIndex(current.agent ? 1 : 0)
    let loaded: string | undefined
    let loadError: unknown
    let loading: Promise<void> | undefined
    const summarize = () => {
      const custom = [
        current.start.input()?.agent ??
          (directory.value.trim() === (loaded ?? current.directory) && agent.getSelectedIndex() > 0
            ? choices[agent.getSelectedIndex() - 1]
            : undefined),
        model.value.trim(),
      ]
        .filter(Boolean)
        .map((value) => label(value!))
      context.height = current.variant ? 3 : 2
      if (workspace.getSelectedIndex() === 1 && !current.worktree?.directory) custom.push("new worktree")
      context.content = `Directory: ${label(directory.value, 4096)}\nSettings · Tab${custom.length ? ` · ${custom.join(" · ")}` : ""} · Ctrl+L Models${current.variant ? `\nModel variant ${label(current.variant)}` : ""}`
    }
    directory.on("input", summarize)
    model.on("input", () => {
      if (model.value.trim() !== current.model) current.variant = undefined
      summarize()
    })
    agent.on("selectionChanged", summarize)
    workspace.on("selectionChanged", summarize)
    summarize()

    const load = (): Promise<void> => {
      if (state.closed || state.modal !== dialog || !state.connected) return Promise.resolve()
      const requested = directory.value.trim()
      if (loaded === requested) return Promise.resolve()
      if (loading) return loading.then(() => load())
      loaded = undefined
      loadError = undefined
      agent.options = [{ name: "Loading agents…", description: "" }]
      loading = connection
        .agents(requested)
        .then((result) => {
          if (state.closed || state.modal !== dialog || requested !== directory.value.trim()) return
          choices = result.map((item) => item.id)
          if (requested === current.directory && current.agent && !choices.includes(current.agent))
            choices.unshift(current.agent)
          loaded = requested
          agent.options = [
            { name: "Server default", description: "" },
            ...choices.map((id) => ({ name: label(id), description: "" })),
          ]
          agent.setSelectedIndex(
            requested === current.directory && current.agent ? choices.indexOf(current.agent) + 1 : 0,
          )
          summarize()
        })
        .catch((error) => {
          if (state.closed || state.modal !== dialog || requested !== directory.value.trim()) return
          loadError = error
          dialog.error.content = `Cannot load agents: ${errorText(error)}. Ctrl+S retries.`
        })
        .finally(() => {
          loading = undefined
        })
      return loading
    }
    directory.on("change", () => void load())
    const save = () => {
      const requested = directory.value.trim()
      // A pending discovery has no selection for the new directory. Never
      // relabel the old directory's agent as a choice belonging to the new one.
      current.agent =
        loaded === requested
          ? agent.getSelectedIndex() > 0
            ? choices[agent.getSelectedIndex() - 1]
            : undefined
          : current.directory === requested
            ? current.agent
            : undefined
      current.prompt = task.plainText
      current.cursor = task.cursorOffset
      current.directory = requested
      current.isolate = workspace.getSelectedIndex() === 1
      if (model.value.trim() !== current.model) current.variant = undefined
      current.model = model.value.trim()
    }
    dialog.save = () => {
      save()
      const submitted = current.start.input()
      if (submitted) Object.assign(current, submitted, { model: submitted.model ?? "" })
      say(submitted ? "Original submission kept · n to resume" : "Draft kept · n to resume")
    }
    dialog.discard = () => {
      draft = undefined
    }
    dialog.chooseModel = () => {
      if (current.start.input()) {
        dialog.error.content = "The original submission is locked. Inspect it with Ctrl+O before changing its model."
        return
      }
      save()
      dialogs.close(false)
      models.pick({
        directory: current.directory,
        current: current.model,
        choose: (value) => {
          if (current.model !== value) current.variant = undefined
          current.model = value
          open()
        },
        cancel: open,
      })
    }
    dialog.chooseAgent = () => {
      if (current.start.input()) {
        dialog.error.content = "The original submission is locked. Inspect it with Ctrl+O before changing its agent."
        return
      }
      dialog.settings?.()
      agent.focus()
      dialogs.reveal(dialog, agent)
      void load()
    }
    dialog.chooseVariant = () => {
      if (current.start.input()) {
        dialog.error.content = "The original submission is locked. Inspect it before changing its variant."
        return
      }
      save()
      const separator = current.model.indexOf("/")
      if (separator < 1 || separator === current.model.length - 1) {
        dialog.error.content = "Choose a model with Ctrl+L before selecting /effort."
        return
      }
      dialogs.close(false)
      variants.pick({
        directory: current.directory,
        model: { providerID: current.model.slice(0, separator), id: current.model.slice(separator + 1) },
        current: current.variant,
        choose: (variant) => {
          current.variant = variant
          // This picker closes after its callback; reopen only once its modal is gone.
          state.modal?.box.once("destroyed", () =>
            queueMicrotask(() => {
              if (!state.closed && !state.modal) open()
            }),
          )
        },
        cancel: open,
      })
    }
    dialog.key = (key) => {
      if (matchesKey(key, "l", { ctrl: true })) {
        dialog.chooseModel?.()
        return true
      }
      if (!matchesKey(key, "o", { ctrl: true }) || !current.start.input()) return false
      dialog.save?.()
      dialogs.close(false)
      openSession(current.start.sessionID, true)
      return true
    }
    dialog.submit = async () => {
      if (!state.connected) throw new Error("Reconnect before sending. Your draft is kept.")
      const isRetry = !!current.start.input()
      if (!isRetry) {
        if (workspace.getSelectedIndex() === 1 && !current.worktree?.directory) {
          // One name per draft: a retry finds the worktree an uncertain attempt made instead of adding one.
          const worktree = (current.worktree ??= { name: `tui-${crypto.randomUUID().slice(0, 8)}`, attempted: false })
          const retry = worktree.attempted
          worktree.attempted = true
          dialog.error.content = "Preparing a new git worktree on the server…"
          const result = await connection.worktree(directory.value.trim(), worktree.name, retry)
          if (result.status === "failed") {
            current.worktree = undefined
            throw new Error(
              `The server could not prepare the worktree${result.message ? `: ${result.message}` : ""}. Ctrl+S tries a new one.`,
            )
          }
          worktree.directory = result.directory
          directory.value = result.directory
          say(`Worktree ${worktree.name} is ready.`)
        }
        await load()
        if (loaded !== directory.value.trim())
          throw loadError ?? new Error("Cannot load this directory's agents. Check Directory and retry.")
        save()
      }
      const session = await current
        .start({
          directory: current.directory,
          agent: current.agent,
          model: current.model || undefined,
          ...(current.variant !== undefined ? { variant: current.variant } : {}),
          prompt: current.prompt,
        })
        .finally(() => {
          dialog.reference = current.start.input() ? current.start.sessionID : undefined
        })
      defaults = { directory: current.directory, agent: current.agent, model: current.model, variant: current.variant }
      draft = undefined
      if (state.closed) return
      let folderError = ""
      if (
        state.snapshot?.workingFolders !== undefined &&
        !state.snapshot.workingFolders.some((folder) => folderContains(folder, current.directory))
      )
        await connection.folders.open(current.directory).catch((error) => {
          folderError = `Folder sync failed: ${errorText(error)}`
        })
      openSession(session.id, false, session)
      say(`Task sent. The session is open.${folderError ? ` ${folderError}` : ""}`, !!folderError)
    }
    dialog.reference = submitted ? current.start.sessionID : undefined
    dialog.error.height = submitted ? 4 : 2
    dialog.error.content = submitted
      ? `Session: ${current.start.sessionID}\nCtrl+O inspect · Enter retry · Esc keep · F4 discard`
      : "Enter Send · Shift/Alt+Enter newline\nEsc keep · Ctrl+L Models · F4 discard"
    slash.attach(
      dialog,
      task,
      () => ({ directory: directory.value.trim() }),
      () => !!current.start.input(),
    )
    mentions.attach(
      dialog,
      task,
      () => ({ directory: directory.value.trim() }),
      () => !!current.start.input(),
    )
    dialogs.resize()
    task.focus()
    void load()
  }

  return {
    open,
    get hasDraft() {
      return !!draft
    },
  }
}
