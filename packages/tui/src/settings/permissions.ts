import { object } from "../response-validation"
import { label } from "../state"
import { confirm, section, type SettingsContext } from "./shared"

export function permissions(ctx: SettingsContext) {
  const { connection } = ctx
  return section(
    ctx,
    "Permissions",
    () =>
      Promise.all([
        connection.api("/global/permission-checks").then(object),
        connection.client.permissions.listSaved(),
      ]),
    ([checks, saved], picker) => {
      const enforced = checks.enforced === true
      picker.text.content = `Saved rules come from "Allow always". ${saved.length ? "Enter on a rule removes it." : "None saved."}`
      picker.set([
        {
          name: `Permission checks: ${enforced ? "on" : "off"}`,
          description: enforced ? "Tools ask before acting unless a rule allows them" : "Tools act without asking",
          run: () =>
            confirm(
              ctx,
              `Turn permission checks ${enforced ? "off" : "on"}?`,
              enforced
                ? "Agents on this server will run tools without asking."
                : "Agents will ask before running tools.",
              async () => {
                await connection.api("/global/permission-checks", { method: "PUT", body: { enforced: !enforced } })
                ctx.say(`Permission checks ${enforced ? "off" : "on"}.`)
              },
            ),
        },
        ...saved.map((rule) => ({
          name: `${label(rule.action, 30)} · ${label(rule.resource, 80)}`,
          description: "Saved rule",
          run: () =>
            confirm(ctx, "Remove this saved rule?", `${rule.action} ${rule.resource} will ask again.`, async () => {
              await connection.client.permissions.removeSaved({ id: rule.id })
              ctx.say("Saved rule removed.")
            }),
        })),
      ])
    },
  )
}
