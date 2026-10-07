import { SelectRenderable, TextRenderable, TextAttributes } from "@opentui/core"
import { display } from "../messages"
import { label, sessionTitle } from "../state"
import { color } from "../theme"
import { printableKey } from "../keys"
import { fitHints } from "../changes/heading"
import type { ModalState } from "../state"
import type { RequestContext } from "./context"

// A prompt that opened on its own ignores digits this long, so a digit typed into the reply as it appears cannot answer it.
const autoOpenGuardMs = 500

// Longest resource the dialog shows whole; a longer one is cut, so Allow always cannot be confirmed blind.
const resourceLimit = 1000

/** `auto` marks a prompt the dashboard opened itself rather than one the user asked for with `p` or Enter. */
export function permission(ctx: RequestContext, auto = false) {
  const request = ctx.state.detail?.permissions[0]
  if (!request || ctx.state.detail?.sessionID !== ctx.state.selected)
    return ctx.say("No pending permission for the selected session.")
  trackShown(ctx, `${request.sessionID}:${request.id}`)
  const dialog = ctx.dialogs.open("Permission request", false, 24, true)
  if (!dialog) return
  describe(ctx, dialog, request)
  // "Always" saves the server's own rule for this request, so it is offered only when the server names one.
  const rules = request.save ?? []
  const cut = rules.length > 0 && showRules(ctx, dialog, rules, request.resources)
  const choice = new SelectRenderable(ctx.renderer, {
    height: rules.length ? 3 : 2,
    options: [
      { name: "1 Reject", description: "" },
      { name: "2 Allow once · this request only", description: "" },
      ...(rules.length
        ? [{ name: `3 Allow always · saves ${savedWhat(rules, request.resources)}`, description: "" }]
        : []),
    ],
    showDescription: false,
    backgroundColor: color.bg,
    textColor: color.text,
    selectedTextColor: color.accent,
    selectedBackgroundColor: color.selected,
  })
  dialog.form.add(choice)
  ctx.dialogs.track(dialog, choice)
  // Ctrl+S must not save rules the user could not read in full.
  dialog.beforeSubmit = () => {
    if (!cut || choice.getSelectedIndex() !== 2) return false
    dialog.error.content = `! The saved rules are too long to show in full, so Allow always is unavailable.\nChoose Allow once or Reject.`
    return true
  }
  dialog.submit = async () => {
    await ctx.connection.client.permissions.reply({
      sessionID: request.sessionID,
      requestID: request.id,
      reply: (["reject", "once", "always"] as const)[choice.getSelectedIndex()] ?? "reject",
    })
    ctx.say(
      ["Permission rejected.", "Allowed once.", "Allowed always."][choice.getSelectedIndex()] ?? "Permission rejected.",
    )
  }
  wireChoice(ctx, dialog, choice, auto ? Date.now() + autoOpenGuardMs : 0)
  ctx.dialogs.resize()
  choice.focus()
}

/** Allow always saves exactly what is shown as the request when the rules equal the resources. */
function sameAsRequest(save: readonly string[], resources: readonly string[]) {
  return save.length === resources.length && save.every((rule) => resources.includes(rule))
}

function savedWhat(save: readonly string[], resources: readonly string[]) {
  if (sameAsRequest(save, resources)) return resources.length === 1 ? "the command above" : "the commands above"
  return save.length === 1 ? "the rule above" : `the ${save.length} rules above`
}

/**
 * Lists every saved rule above the choice and returns whether the list had to be cut. Rules that equal the
 * request's own resources are already on screen, so they are not repeated; only a cut resource still counts.
 */
function showRules(ctx: RequestContext, dialog: ModalState, save: readonly string[], resources: readonly string[]) {
  if (sameAsRequest(save, resources)) return save.some((pattern) => pattern.length > resourceLimit)
  const shown = save.slice(0, 20)
  const more = save.length - shown.length
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: [
        `Allow always saves ${save.length} ${save.length === 1 ? "rule" : "rules"}:`,
        ...shown.map((pattern) => `• ${label(pattern, 200)}`),
        ...(more > 0 ? [`… and ${more} more`] : []),
      ].join("\n"),
      fg: color.text,
      wrapMode: "char",
      flexShrink: 0,
    }),
  )
  return more > 0 || shown.some((pattern) => pattern.length > 200)
}

type Request = NonNullable<RequestContext["state"]["detail"]>["permissions"][number]

/** The heading, one labelled row each for the session and folder, and the action with its resources. */
function describe(ctx: RequestContext, dialog: ModalState, request: Request) {
  const session = ctx.state.snapshot?.sessions.find((item) => item.id === request.sessionID)
  dialog.recipient = session
  const row = (content: string, fg: string, extra: ConstructorParameters<typeof TextRenderable>[1] = {}) =>
    dialog.form.add(
      new TextRenderable(ctx.renderer, {
        content,
        fg,
        height: 1,
        flexShrink: 0,
        truncate: true,
        wrapMode: "none",
        ...extra,
      }),
    )
  row("Permission request", color.text, { attributes: TextAttributes.BOLD })
  row(`For: ${sessionTitle(session?.title ?? request.sessionID, 80)}`, color.muted)
  if (session?.location.directory) row(`Directory: ${label(session.location.directory, 200)}`, color.muted)
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: `${display(request.action)}\n${request.resources.map((resource) => display(resource, resourceLimit)).join("\n")}`,
      fg: color.text,
      wrapMode: "word",
    }),
  )
}

/** Digits answer at once, Up/Down keep the chosen row on screen for Ctrl+S, and the hints name each key. */
function wireChoice(ctx: RequestContext, dialog: ModalState, choice: SelectRenderable, sendAfter: number) {
  // Up/Down move the select inside a scrolling form; keep the chosen row visible so Ctrl+S never sends blind.
  choice.on("selectionChanged", () => {
    showChoice(dialog, choice)
    hint(ctx, dialog, choice)
  })
  dialog.key = (key) => {
    const index = ["1", "2", "3"].indexOf(printableKey(key))
    if (index < 0 || index >= choice.options.length) return false
    choice.setSelectedIndex(index)
    if (Date.now() >= sendAfter) void ctx.dialogs.submit()
    return true
  }
  hint(ctx, dialog, choice)
}

/** Names the digits and what Ctrl+S does with the chosen row; Enter does not confirm. Entries are kept whole. */
function hint(ctx: RequestContext, dialog: ModalState, choice: SelectRenderable) {
  const chosen = choice.options[choice.getSelectedIndex()]?.name.replace(/^\d /, "").split(" · ")[0] ?? "Reject"
  const keys = [`1-${choice.options.length} answer`, `↑↓ then Ctrl+S ${chosen}`, "PgUp/PgDn scroll", "Esc close"]
  const width = () => (dialog.frame.width > 1 ? dialog.frame.width : ctx.renderer.width) - 4
  const paint = () => (dialog.error.content = fitHints(width(), [], keys))
  dialog.frame.onSizeChange = paint
  paint()
}

function showChoice(dialog: ModalState, choice: SelectRenderable) {
  const rows = choice.height / choice.options.length
  const top = choice.y + choice.getSelectedIndex() * rows - dialog.form.viewport.y
  const over = top + rows - dialog.form.viewport.height
  if (top < 0) dialog.form.scrollBy(top)
  else if (over > 0) dialog.form.scrollBy(over)
}

function trackShown(ctx: RequestContext, key: string) {
  ctx.shownPermissions.add(key)
  if (ctx.shownPermissions.size > 256) ctx.shownPermissions.delete(ctx.shownPermissions.values().next().value!)
}
