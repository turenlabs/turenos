import {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core"
import { matchesKey, printableKey } from "./keys"
import { turenLogo } from "./logo"
import { display } from "./messages"
import { secretField } from "./secret-field"
import { PasswordRequired, serverLabel, type Entry, type Servers, type Target } from "./servers"
import { label } from "./state"
import { color } from "./theme"

type Tone = "muted" | "warning" | "error"

/**
 * Full-screen server chooser. It owns the keyboard while open; the dashboard behind it stays
 * mounted, so cancelling returns to it unchanged and a switch only happens once the new server
 * has answered with valid credentials.
 */
export function createServerPicker(
  renderer: CliRenderer,
  servers: Servers,
  hooks: {
    current: () => { target: Target; connected: boolean } | undefined
    drafts: () => number
    connect: (target: Target, signal: AbortSignal, progress: (text: string) => void) => Promise<void>
    closed: () => void
    quit: () => void
  },
) {
  let view: ReturnType<typeof build> | undefined
  let entries: Entry[] = []
  let selected = 0
  let mode: "list" | "connecting" | "add" | "password" = "list"
  let controller: AbortController | undefined
  let armed: { action: "switch" | "remove" | "quit"; id: string; until: number } | undefined
  let scanning: ReturnType<typeof setInterval> | undefined
  let form: { inputs: InputRenderable[]; index: number } | undefined
  let secret: { target: Target; field: InputRenderable; take: () => string } | undefined
  const visited = new Map<string, Extract<Target, { kind: "url" }>>()

  function build() {
    const overlay = new BoxRenderable(renderer, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 50,
      backgroundColor: color.bg,
      alignItems: "center",
      justifyContent: "center",
      padding: 1,
    })
    const frame = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      maxWidth: 100,
      maxHeight: 36,
      border: true,
      borderStyle: "rounded",
      borderColor: color.border,
      title: " Servers ",
      titleColor: color.text,
      backgroundColor: color.panel,
      paddingX: 2,
      paddingY: 1,
      flexDirection: "column",
      gap: 1,
    })
    overlay.add(frame)
    const logo = new TextRenderable(renderer, {
      ...turenLogo(false),
      alignSelf: "center",
      flexShrink: 0,
      wrapMode: "none",
    })
    const heading = new TextRenderable(renderer, {
      content: "",
      fg: color.text,
      attributes: TextAttributes.BOLD,
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      truncate: true,
    })
    const list = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      minHeight: 3,
      contentOptions: { flexDirection: "column", paddingRight: 1 },
    })
    const fields = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0, visible: false })
    const status = new TextRenderable(renderer, { content: "", fg: color.muted, flexShrink: 0, wrapMode: "word" })
    const keys = new TextRenderable(renderer, {
      content: "",
      fg: color.muted,
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      truncate: true,
    })
    for (const item of [logo, heading, list, fields, status, keys]) frame.add(item)
    renderer.root.add(overlay)
    return { overlay, logo, heading, list, fields, status, keys, rows: [] as TextRenderable[] }
  }

  function open(note?: string, tone: Tone = "muted") {
    if (!view) {
      view = build()
      renderer.currentFocusedRenderable?.blur()
      renderer.keyInput.on("keypress", keypress)
      renderer.on("resize", paint)
      scanning = setInterval(() => {
        if (mode === "list") void rescan()
      }, 3000)
    }
    mode = "list"
    say(note ?? "", tone)
    void rescan()
  }

  /** Opens straight into connecting, as at startup. */
  function start(target: Target) {
    open()
    void connect(target)
  }

  function close(restore = true) {
    if (!view) return
    controller?.abort()
    if (scanning) clearInterval(scanning)
    renderer.keyInput.off("keypress", keypress)
    renderer.off("resize", paint)
    view.overlay.destroyRecursively()
    view = undefined
    form = undefined
    secret = undefined
    armed = undefined
    mode = "list"
    if (restore) hooks.closed()
  }

  async function rescan() {
    const current = hooks.current()?.target
    // A server opened by URL is not saved; keep it listed for this run so switching back stays possible.
    if (current?.kind === "url" && !current.saved) visited.set(current.id, current)
    const id = entries[selected]?.target.id ?? current?.id
    const next = await servers.scan()
    if (!view) return
    entries = [
      ...[...visited.values()].map((target) => ({
        target,
        group: "Opened this session" as const,
        detail: target.url,
      })),
      ...next,
    ]
    selected = Math.max(
      0,
      entries.findIndex((entry) => entry.target.id === id),
    )
    if (!view.status.plainText && servers.problems().length) say(servers.problems().join(" "), "warning")
    paint()
  }

  function paint() {
    if (!view) return
    const current = hooks.current()
    view.logo.visible = renderer.height >= 30
    view.heading.content = current
      ? `Connected to ${label(serverLabel(current.target), 80)}${current.connected ? "" : " (disconnected)"} · choose a server`
      : "Choose a TurenOS server"
    view.list.visible = mode === "list" || mode === "connecting"
    view.fields.visible = mode === "add" || mode === "password"
    view.rows.forEach((row) => row.destroyRecursively())
    const width = Math.min(30, Math.max(10, ...entries.map((entry) => label(entry.target.name, 64).length)))
    // Screen line of each entry, counting group headings and the gap above all but the first.
    const offsets: number[] = []
    let line = 0
    view.rows = entries.flatMap((entry, index) => {
      const heading =
        entries[index - 1]?.group !== entry.group
          ? [
              new TextRenderable(renderer, {
                content: entry.group.toUpperCase(),
                fg: color.muted,
                attributes: TextAttributes.BOLD,
                marginTop: index ? 1 : 0,
                height: 1,
                flexShrink: 0,
              }),
            ]
          : []
      const active = current?.target.id === entry.target.id
      const chosen = index === selected
      const row = new TextRenderable(renderer, {
        content: `${chosen ? "›" : " "} ${active ? "●" : "○"} ${label(entry.target.name, 64).padEnd(width)}  ${label(entry.detail, 200)}${active ? "  · current" : ""}`,
        fg: active ? color.accent : color.text,
        bg: chosen ? color.selected : undefined,
        height: 1,
        width: "100%",
        flexShrink: 0,
        wrapMode: "none",
        truncate: true,
        onMouseDown: (event) => {
          if (event.button !== 0 || mode !== "list") return
          event.preventDefault()
          selected = index
          choose()
        },
      })
      if (heading.length) line += index ? 2 : 1
      offsets.push(line++)
      return [...heading, row]
    })
    if (!entries.length)
      view.rows.push(
        new TextRenderable(renderer, {
          content: "No TurenOS server found. Open the TurenOS app, or press a to add a server.",
          fg: color.muted,
          wrapMode: "word",
        }),
      )
    view.rows.forEach((row) => view!.list.add(row))
    const top = offsets[selected] ?? 0
    if (top <= view.list.scrollTop) view.list.scrollTo(Math.max(0, top - 1))
    if (top >= view.list.scrollTop + view.list.viewport.height) view.list.scrollTo(top - view.list.viewport.height + 1)
    view.keys.content =
      mode === "connecting"
        ? "Esc cancel"
        : mode === "add"
          ? "Tab next field · Enter save · Esc cancel"
          : mode === "password"
            ? "Enter connect · Ctrl+U clear · Esc cancel"
            : `↑↓ choose · Enter connect · a add · d remove · r rescan${current ? " · Esc back" : ""} · q quit`
  }

  function say(text: string, tone: Tone = "muted") {
    if (!view) return
    view.status.content = display(text, 1000)
    view.status.fg = color[tone]
  }

  function keypress(key: KeyEvent) {
    if (!view || key.eventType === "release") return
    if (mode === "add" || mode === "password") return fieldKey(key)
    key.preventDefault()
    if (mode === "connecting") {
      if (matchesKey(key, "escape") || matchesKey(key, "c", { ctrl: true })) cancel()
      return
    }
    const character = printableKey(key)
    if (matchesKey(key, "up") || character === "k") return move(-1)
    if (matchesKey(key, "down") || character === "j") return move(1)
    if (matchesKey(key, "enter")) return choose()
    if (character === "a") return add()
    if (character === "d") return remove()
    if (character === "r") {
      say("Rescanned.")
      return void rescan()
    }
    if ((matchesKey(key, "escape") || character === "s") && hooks.current()) return close()
    if (character === "q" || matchesKey(key, "c", { ctrl: true })) return quit()
  }

  function move(delta: number) {
    if (!entries.length) return
    selected = (selected + delta + entries.length) % entries.length
    armed = undefined
    paint()
  }

  function choose() {
    const entry = entries[selected]
    if (!entry) return
    const current = hooks.current()
    if (current?.target.id === entry.target.id && current.connected) return close()
    const drafts = hooks.drafts()
    if (drafts && !confirmed("switch", entry.target.id))
      return say(
        `${drafts} unsent draft${drafts === 1 ? "" : "s"} on ${current?.target.name ?? "this server"} will be discarded. Press Enter again to switch.`,
        "warning",
      )
    void connect(entry.target)
  }

  async function connect(target: Target) {
    controller?.abort()
    const attempt = new AbortController()
    controller = attempt
    mode = "connecting"
    say(`Connecting to ${target.name}…`)
    paint()
    try {
      await hooks.connect(target, attempt.signal, (text) => {
        if (!attempt.signal.aborted) say(text)
      })
      if (!attempt.signal.aborted) close(false)
    } catch (error) {
      if (attempt.signal.aborted || !view) return
      mode = "list"
      if (error instanceof PasswordRequired) return password(target)
      say(error instanceof Error ? error.message : "Could not connect.", "error")
      paint()
    }
  }

  function cancel() {
    controller?.abort()
    mode = "list"
    say("Connection cancelled.")
    paint()
  }

  function remove() {
    const target = entries[selected]?.target
    if (!target || !("saved" in target) || !target.saved)
      return say("Only saved servers can be removed. Local and TurenOS Desktop servers are discovered.", "warning")
    if (hooks.current()?.target.id === target.id)
      return say("Switch to another server before removing this one.", "warning")
    if (!confirmed("remove", target.id)) return say(`Press d again to remove ${target.name}.`, "warning")
    void servers.remove(target).then(
      () => {
        say(`Removed ${target.name}.`)
        return rescan()
      },
      (error: unknown) => say(error instanceof Error ? error.message : "Could not remove the server.", "error"),
    )
  }

  function quit() {
    const drafts = hooks.drafts()
    if (drafts && !confirmed("quit", ""))
      return say(`${drafts} unsent drafts will be lost. Press q again to quit.`, "warning")
    hooks.quit()
  }

  function confirmed(action: "switch" | "remove" | "quit", id: string) {
    if (armed?.action === action && armed.id === id && armed.until > Date.now()) {
      armed = undefined
      return true
    }
    armed = { action, id, until: Date.now() + 5000 }
    return false
  }

  function add() {
    if (!view) return
    mode = "add"
    const inputs = [
      ["Address", "https://turen.example or user@host[:port]"],
      ["Name (optional)", ""],
      ["Username (optional, URL servers)", ""],
    ].map(([title, placeholder]) => {
      view!.fields.add(new TextRenderable(renderer, { content: title!, fg: color.muted, height: 1 }))
      const input = new InputRenderable(renderer, {
        width: "100%",
        maxLength: 512,
        placeholder: placeholder!,
        backgroundColor: color.bg,
        focusedBackgroundColor: color.selected,
        textColor: color.text,
        placeholderColor: color.muted,
        marginBottom: 1,
      })
      view!.fields.add(input)
      return input
    })
    form = { inputs, index: 0 }
    inputs[0]!.focus()
    say(`Saved to ${servers.configPath}. Passwords are never saved.`)
    paint()
  }

  function password(target: Target) {
    if (!view) return
    mode = "password"
    view.fields.add(
      new TextRenderable(renderer, {
        content: `Password for ${label(target.name, 80)} (hidden; kept only until you quit)`,
        fg: color.muted,
        height: 1,
      }),
    )
    const field = secretField(renderer, {
      limit: 1024,
      reject: () => say("At most 1,024 characters and no control characters. Ctrl+U clears.", "error"),
    })
    view.fields.add(field.field)
    field.field.focus()
    secret = { target, field: field.field, take: field.take }
    say(`${target.name} needs a password.`, "warning")
    paint()
  }

  function fieldKey(key: KeyEvent) {
    // Keys go to whatever holds focus next; make sure that is this form, not a field behind it.
    const field = secret?.field ?? form?.inputs[form.index]
    if (field && renderer.currentFocusedRenderable !== field) field.focus()
    if (matchesKey(key, "escape") || matchesKey(key, "c", { ctrl: true })) {
      key.preventDefault()
      say("")
      return endFields()
    }
    if (form && (matchesKey(key, "tab") || matchesKey(key, "tab", { shift: true }))) {
      key.preventDefault()
      form.index = (form.index + (key.shift ? -1 : 1) + form.inputs.length) % form.inputs.length
      return form.inputs[form.index]!.focus()
    }
    if (!matchesKey(key, "enter")) return
    key.preventDefault()
    if (secret) {
      const target = secret.target
      const value = secret.take()
      if (!value) return say("Enter the server's password.", "error")
      servers.remember(target, value)
      endFields()
      return void connect(target)
    }
    if (!form) return
    const [address, name, username] = form.inputs.map((input) => input.value)
    void servers.add({ address: address!, name, username }).then(
      async (target) => {
        endFields()
        await rescan()
        selected = Math.max(
          0,
          entries.findIndex((entry) => entry.target.id === target.id),
        )
        say(`Saved ${target.name}. Press Enter to connect.`)
        paint()
      },
      (error: unknown) => say(error instanceof Error ? error.message : "Could not save the server.", "error"),
    )
  }

  function endFields() {
    if (!view) return
    for (const child of view.fields.getChildren()) child.destroyRecursively()
    form = undefined
    secret = undefined
    mode = "list"
    renderer.currentFocusedRenderable?.blur()
    paint()
  }

  return { open, start, close, visible: () => !!view }
}

export type ServerPicker = ReturnType<typeof createServerPicker>
