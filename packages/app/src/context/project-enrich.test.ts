import { describe, expect, test } from "bun:test"
import type { Project } from "@turenlabs/sdk/v2/client"
import { enrichProject, GLOBAL_PROJECT_ID, isSharedProject, localProjectMeta } from "./project-enrich"

const project = { worktree: "/repo/app", expanded: false }

const row = (overrides: Partial<Project> = {}): Project => ({
  id: "prj_1",
  worktree: "/repo",
  time: { created: 0, updated: 0 },
  sandboxes: [],
  ...overrides,
})

describe("enrichProject", () => {
  test("keeps the opened worktree over the project row worktree", () => {
    expect(enrichProject({ project, metadata: row() }).worktree).toBe("/repo/app")
  })

  test("shows the local name when the shared global row cannot carry one", () => {
    const result = enrichProject({
      project,
      metadata: row({ id: GLOBAL_PROJECT_ID, worktree: "/" }),
      meta: { name: "Documents" },
    })

    expect(result.name).toBe("Documents")
  })

  test("shows the local name when no project row is known yet", () => {
    expect(enrichProject({ project, meta: { name: "Documents" } }).name).toBe("Documents")
  })

  test("prefers the server name over a stale local one", () => {
    const result = enrichProject({ project, metadata: row({ name: "Server" }), meta: { name: "Local" } })

    expect(result.name).toBe("Server")
  })

  test("falls back to the folder name once the local name is cleared", () => {
    expect(enrichProject({ project, metadata: row({ id: GLOBAL_PROJECT_ID }), meta: {} }).name).toBeUndefined()
  })

  test("surfaces local color and startup command", () => {
    const result = enrichProject({
      project,
      metadata: row({ id: GLOBAL_PROJECT_ID }),
      meta: { icon: { color: "mint" }, commands: { start: "bun dev" } },
    })

    expect(result.icon?.color).toBe("mint")
    expect(result.commands?.start).toBe("bun dev")
  })

  test("per-worktree icon override wins over the shared row icon", () => {
    const result = enrichProject({
      project,
      metadata: row({ icon: { override: "row.png", color: "pink" } }),
      icon: "local.png",
    })

    expect(result.icon?.override).toBe("local.png")
    expect(result.icon?.color).toBe("pink")
  })

  test("leaves the icon absent when nothing sets one", () => {
    expect(enrichProject({ project, metadata: row() }).icon).toBeUndefined()
  })
})

describe("localProjectMeta", () => {
  test("keeps an untouched field out of the patch", () => {
    expect(localProjectMeta({ name: "Docs" })).toEqual({ name: "Docs" })
  })

  test("clears a field the edit emptied", () => {
    expect(localProjectMeta({ name: "", icon: { color: "", override: "" }, commands: { start: "" } })).toEqual({
      name: undefined,
      icon: { color: undefined, override: undefined },
      commands: { start: undefined },
    })
  })

  test("a color-only update does not clear the icon override", () => {
    expect(localProjectMeta({ icon: { color: "mint" } })).toEqual({ icon: { color: "mint" } })
  })

  test("round-trips a full edit", () => {
    expect(
      localProjectMeta({ name: "Docs", icon: { color: "mint", override: "data:x" }, commands: { start: "bun dev" } }),
    ).toEqual({ name: "Docs", icon: { color: "mint", override: "data:x" }, commands: { start: "bun dev" } })
  })
})

describe("isSharedProject", () => {
  test("treats the global row and a missing id as shared", () => {
    expect(isSharedProject(GLOBAL_PROJECT_ID)).toBe(true)
    expect(isSharedProject(undefined)).toBe(true)
    expect(isSharedProject("prj_1")).toBe(false)
  })
})
