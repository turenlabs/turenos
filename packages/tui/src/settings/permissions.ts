import { object } from "../response-validation"
import { errorText } from "../server"
import { label } from "../state"
import { confirm, section, trail, type SettingsContext } from "./shared"

const CHECKS = {
  unknown: "The server did not report this; the toggle is unavailable",
  on: "Tools ask before acting unless a rule allows them",
  off: "Tools act without asking",
}

export function permissions(ctx: SettingsContext) {
  const { connection } = ctx
  const reopen = () => void permissions(ctx)
  return section(
    ctx,
    trail("Permissions"),
    () => Promise.all([connection.api("/global/permission-checks").then(object), savedRules(ctx)]),
    ([checks, saved], picker) => {
      // A missing or malformed field must not read as "off": the toggle stays unavailable until the server says.
      const enforced = typeof checks.enforced === "boolean" ? checks.enforced : undefined
      const status = enforced === undefined ? "unknown" : enforced ? "on" : "off"
      picker.text.content = `Saved rules come from "Allow always". ${saved.length ? "Enter on a rule removes it." : "None saved."}`
      const setChecks = async () => {
        await connection.api("/global/permission-checks", { method: "PUT", body: { enforced: !enforced } })
        ctx.say(`Permission checks ${enforced ? "off" : "on"}.`)
      }
      // Only off is risky: turning checks on applies at once.
      const turnOn = () =>
        void setChecks().then(reopen, (error: unknown) => {
          ctx.say(errorText(error), true)
          reopen()
        })
      picker.set([
        {
          name: `Permission checks: ${status}`,
          description: CHECKS[status],
          run: () =>
            enforced === undefined
              ? reopen()
              : enforced
                ? confirm(
                    ctx,
                    "Turn permission checks off?",
                    "Agents on this server will run tools without asking.",
                    setChecks,
                    reopen,
                  )
                : turnOn(),
        },
        ...saved.map((rule) => ({
          name: `${label(rule.action, 30)} · ${label(rule.resource, 80)}`,
          description: `Saved rule · ${label(rule.directory, 80)}`,
          run: () =>
            confirm(
              ctx,
              "Remove this saved rule?",
              `${label(rule.action, 30)} ${label(rule.resource, 200)} will ask again.`,
              async () => {
                await connection.client.permissions.removeSaved({ id: rule.id })
                ctx.say("Saved rule removed.")
              },
              reopen,
            ),
        })),
      ])
    },
    "change",
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
