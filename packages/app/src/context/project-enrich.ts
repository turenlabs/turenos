import type { Project } from "@turenlabs/sdk/v2/client"
import type { ProjectMeta } from "./global-sync/types"

/**
 * The one project row the server hands back for every directory that is not a
 * git repository. It is stored with worktree "/" and is shared by all of them,
 * so its name, icon and commands cannot describe any single directory.
 */
export const GLOBAL_PROJECT_ID = "global"

/** True when a project has no per-directory row of its own on the server. */
export const isSharedProject = (projectID: string | undefined): projectID is undefined | typeof GLOBAL_PROJECT_ID =>
  !projectID || projectID === GLOBAL_PROJECT_ID

export type EnrichedProject = Partial<Project> & { worktree: string; expanded: boolean }

/**
 * Translate a project update into a local override patch. The server row takes
 * an omitted field to mean "leave alone" and an empty string to mean "clear";
 * locally, cleared is simply absent.
 */
export function localProjectMeta(input: {
  name?: string
  icon?: Project["icon"]
  commands?: Project["commands"]
}): ProjectMeta {
  const patch: ProjectMeta = {}
  if (input.name !== undefined) patch.name = input.name || undefined
  if (input.icon) {
    patch.icon = {}
    if (input.icon.color !== undefined) patch.icon.color = input.icon.color || undefined
    if (input.icon.override !== undefined) patch.icon.override = input.icon.override || undefined
  }
  if (input.commands?.start !== undefined) patch.commands = { start: input.commands.start || undefined }
  return patch
}

/**
 * A project's presentation comes from three stores, and every one of them has
 * to be read here or its writes are invisible:
 *
 * - `metadata` is the server row. Authoritative whenever it has a value.
 * - `meta` is the per-worktree local cache. It is the only store a directory
 *   without its own server row (see `GLOBAL_PROJECT_ID`) can be renamed into,
 *   so it fills in whatever the row leaves empty.
 * - `icon` is the per-worktree icon override cache, which wins outright:
 *   sibling directories of one repo share a row but not their icons.
 */
export function enrichProject(input: {
  project: { worktree: string; expanded: boolean }
  metadata?: Project
  meta?: ProjectMeta
  icon?: string
}): EnrichedProject {
  const base: EnrichedProject = { ...input.metadata, ...input.project }
  const meta = input.meta

  const name = base.name || meta?.name
  if (name) base.name = name

  const start = base.commands?.start || meta?.commands?.start
  if (start) base.commands = { ...base.commands, start }

  const color = base.icon?.color || meta?.icon?.color
  const override = input.icon || base.icon?.override || meta?.icon?.override
  if (color || override) base.icon = { ...base.icon, color: color || undefined, override: override || undefined }

  return base
}
