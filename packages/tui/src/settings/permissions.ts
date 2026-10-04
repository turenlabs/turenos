import { object } from "../response-validation"
import { label } from "../state"
import { confirm, section, type SettingsContext } from "./shared"

export function permissions(ctx: SettingsContext) {
  const { connection } = ctx
  const reopen = () => void permissions(ctx)
  return section(
    ctx,
    "Permissions",
    () => Promise.all([connection.api("/global/permission-checks").then(object), savedRules(ctx)]),
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
              reopen,
            ),
        },
        ...saved.map((rule) => ({
          name: `${label(rule.action, 30)} · ${label(rule.resource, 80)}`,
          description: `Saved rule · ${label(rule.directory, 80)}`,
          run: () =>
            confirm(
              ctx,
              "Remove this saved rule?",
              `${rule.action} ${rule.resource} will ask again.`,
              async () => {
                await connection.client.permissions.removeSaved({ id: rule.id })
                ctx.say("Saved rule removed.")
              },
              reopen,
            ),
        })),
      ])
    },
  )
}

/** The server lists saved rules per project, so ask for the selected session's project and every other one in view. */
async function savedRules(ctx: SettingsContext) {
  const sessions = ctx.state.snapshot?.sessions ?? []
  const selected = sessions.find((item) => item.id === ctx.state.selected)
  const projects = [
    ...new Map([selected, ...sessions].flatMap((item) => (item ? [[item.projectID, item] as const] : []))).values(),
  ]
  const lists = await Promise.all(
    projects
      .slice(0, 20)
      .map((session) =>
        ctx.connection.client.permissions
          .listSaved({ projectID: session.projectID })
          .then((rules) => rules.map((rule) => ({ ...rule, directory: session.location.directory }))),
      ),
  )
  if (!lists.length)
    return (await ctx.connection.client.permissions.listSaved()).map((rule) => ({ ...rule, directory: "this project" }))
  return [...new Map(lists.flat().map((rule) => [rule.id, rule])).values()]
}
