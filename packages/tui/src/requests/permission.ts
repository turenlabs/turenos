import { SelectRenderable, TextRenderable, TextAttributes } from "@opentui/core"
import { display } from "../messages"
import { label } from "../state"
import { color } from "../theme"
import { recipient, type RequestContext } from "./context"

export function permission(ctx: RequestContext) {
  const request = ctx.state.detail?.permissions[0]
  if (!request || ctx.state.detail?.sessionID !== ctx.state.selected)
    return ctx.say("No pending permission for the selected session.")
  const dialog = ctx.dialogs.open("Permission request", false, Math.min(28, 18 + request.resources.length), true)
  if (!dialog) return
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: "Permission request",
      fg: color.text,
      attributes: TextAttributes.BOLD,
      height: 1,
      flexShrink: 0,
    }),
  )
  recipient(ctx, dialog, request.sessionID)
  dialog.form.add(
    new TextRenderable(ctx.renderer, {
      content: `${display(request.action)}\n\n${request.resources.map((resource) => display(resource, 1000)).join("\n")}`,
      fg: color.text,
      wrapMode: "word",
    }),
  )
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
    ctx.say(choice.getSelectedIndex() === 2 ? "Allowed; the server saved this rule." : "Permission response sent.")
  }
  dialog.error.content = "Ctrl+S Send · Esc close · PgUp/PgDn scroll"
  ctx.dialogs.resize()
  choice.focus()
}
