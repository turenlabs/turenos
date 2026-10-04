import { SelectRenderable, TextRenderable, TextAttributes } from "@opentui/core"
import { display } from "../messages"
import { label } from "../state"
import { color } from "../theme"
import { printableKey } from "../keys"
import type { ModalState } from "../state"
import type { RequestContext } from "./context"

export function permission(ctx: RequestContext) {
  const request = ctx.state.detail?.permissions[0]
  if (!request || ctx.state.detail?.sessionID !== ctx.state.selected)
    return ctx.say("No pending permission for the selected session.")
  trackShown(ctx, `${request.sessionID}:${request.id}`)
  const dialog = ctx.dialogs.open("Permission request", false, 24, true)
  if (!dialog) return
  describe(ctx, dialog, request)
  // "Always" saves the server's own rule for this request, so it is offered only when the server names one.
  const always = request.save?.length
    ? `Also allow ${request.save.map((pattern) => display(pattern, 200)).join(", ")} from now on`
    : undefined
  const choice = new SelectRenderable(ctx.renderer, {
    height: always ? 6 : 4,
    options: [
      { name: "Reject", description: "Do not allow this operation" },
      { name: "Allow once", description: "Allow only this request" },
      ...(always ? [{ name: "Allow always", description: label(always, 300) }] : []),
    ],
    backgroundColor: color.bg,
    textColor: color.text,
    descriptionColor: color.muted,
    selectedTextColor: color.accent,
    selectedBackgroundColor: color.selected,
  })
  dialog.form.add(choice)
  ctx.dialogs.track(dialog, choice)
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
  wireChoice(dialog, choice)
  ctx.dialogs.resize()
  choice.focus()
}

type Request = NonNullable<RequestContext["state"]["detail"]>["permissions"][number]

/** The heading, one dim line naming the session and folder, and the action with its resources. */
function describe(ctx: RequestContext, dialog: ModalState, request: Request) {
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: "Permission request",
      fg: color.text,
      attributes: TextAttributes.BOLD,
      height: 1,
      flexShrink: 0,
    }),
  )
  const session = ctx.state.snapshot?.sessions.find((item) => item.id === request.sessionID)
  dialog.recipient = session
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: [label(session?.title ?? request.sessionID, 80), label(session?.location.directory ?? "", 200)]
        .filter(Boolean)
        .join(" · "),
      fg: color.muted,
      height: 1,
      flexShrink: 0,
      truncate: true,
      wrapMode: "none",
    }),
  )
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: `${display(request.action)}\n${request.resources.map((resource) => display(resource, 1000)).join("\n")}`,
      fg: color.text,
      wrapMode: "word",
    }),
  )
}

/** Digits pick a row, Up/Down keep the chosen row on screen, and the hints name each key. */
function wireChoice(dialog: ModalState, choice: SelectRenderable) {
  // Up/Down move the select inside a scrolling form; keep the chosen row visible so Ctrl+S never sends blind.
  choice.on("selectionChanged", () => {
    showChoice(dialog, choice)
    hint(dialog, choice)
  })
  dialog.key = (key) => {
    const index = ["1", "2", "3"].indexOf(printableKey(key))
    if (index < 0 || index >= choice.options.length) return false
    choice.setSelectedIndex(index)
    return true
  }
  hint(dialog, choice)
}

/** Names the digits, the arrows and what Ctrl+S does with the row that is selected now. Enter does not confirm. */
function hint(dialog: ModalState, choice: SelectRenderable) {
  const keys = `↑↓ or ${choice.options.map((option, index) => `${index + 1} ${option.name}`).join(" · ")}`
  const chosen = choice.options[choice.getSelectedIndex()]?.name ?? "Reject"
  dialog.error.content = `${keys}\nCtrl+S ${chosen} · Esc close · PgUp/PgDn scroll`
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
