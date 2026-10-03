import { array, identifier, object, string } from "../response-validation"
import type { Context } from "./context"
import { inputDirectory } from "./transport"

export async function agents(ctx: Context, directory: string) {
  inputDirectory(directory)
  const result = await ctx.client.agents.list({ location: { directory } })
  return result.data.filter((agent) => !agent.hidden && agent.mode !== "subagent")
}

/** Server commands plus the skills of enabled extensions, which run as commands too (as in the desktop). */
export async function commands(
  ctx: Context,
  directory: string,
  workspaceID?: string,
): Promise<{ name: string; description?: string }[]> {
  inputDirectory(directory)
  if (workspaceID !== undefined) identifier(workspaceID)
  const [listed, skills] = await Promise.all([
    ctx.client.commands.list({ location: { directory, workspace: workspaceID } }),
    ctx
      .api("/extension", { directory })
      .then(skillList)
      .catch(() => []),
  ])
  const names = new Set(listed.data.map((item) => item.name))
  return [...listed.data, ...skills.filter((skill) => !names.has(skill.name))]
}

export async function findFiles(
  ctx: Context,
  directory: string,
  query: string,
  workspaceID?: string,
  signal?: AbortSignal,
) {
  inputDirectory(directory)
  if (workspaceID !== undefined) identifier(workspaceID)
  if (query.length > 512) throw new Error("Keep the file search below 512 characters.")
  return (
    await ctx.client.files.find({ location: { directory, workspace: workspaceID }, query, limit: 50 }, { signal })
  ).data
}

// The server owns execution: this admits one command and returns the shell
// message the transcript already renders. Retries reuse the caller's ID.
export async function shell(ctx: Context, sessionID: string, id: string, command: string) {
  checkShell(sessionID, id, command)
  return ctx.client.sessions.shell({ sessionID, id, command })
}

/** The local limits on a shell command, checkable before anything is locked or sent. */
export function checkShell(sessionID: string, id: string, command: string) {
  identifier(sessionID, "ses_")
  identifier(id, "msg_")
  if (!command.trim()) throw new Error("Enter a command to run on the server.")
  if (command.length > 8192) throw new Error("Keep the command below 8,192 characters.")
}

export async function resolveCommand(ctx: Context, text: string, directory: string, workspaceID?: string) {
  const prefix = /^\/([^\s/\\]{1,512})(?:\s|$)/.exec(text)
  if (!prefix) return undefined
  const inventory = await commands(ctx, directory, workspaceID)
  if (!inventory.some((item) => item.name === prefix[1])) return undefined
  return { command: prefix[1]!, arguments: text.slice(prefix[0].length) }
}

export async function runs(ctx: Context, loopID: string) {
  identifier(loopID)
  return (await ctx.client.loops.runList({ loopID })).slice(0, 10)
}

function skillList(value: unknown) {
  return array(value, 2048).flatMap((item) => {
    const extension = object(item)
    if (extension.enabled !== true) return []
    return array(object(extension.manifest).contributions, 256).flatMap((value) => {
      const contribution = object(value)
      if (contribution.type !== "skill") return []
      const description = typeof contribution.description === "string" ? contribution.description : ""
      return [{ name: string(contribution.id, 120), description: `Skill · ${description}` }]
    })
  })
}
