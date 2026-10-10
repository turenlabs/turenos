import { expect, test } from "bun:test"
import { sameSession } from "../src/server/session-identity"
import type { Session } from "../src/server"

const session: Session = {
  id: "ses_main",
  projectID: "project",
  title: "Task",
  location: { directory: "/srv/project" },
  time: { created: 1, updated: 2 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

test("mutation recipients tolerate mutable session metadata", () => {
  expect(
    sameSession(session, {
      ...session,
      title: "Renamed",
      agent: "build",
      model: { providerID: "test", id: "model" },
      time: { ...session.time, updated: 3 },
      cost: 5,
    }),
  ).toBe(true)
})

test("mutation recipients reject a substituted identity or location", () => {
  const changed: Partial<Session>[] = [
    { id: "ses_other" },
    { projectID: "other" },
    { parentID: "ses_parent" },
    { subpath: "other" },
    { time: { ...session.time, created: 3 } },
    { location: { directory: "/srv/other" } },
    { location: { ...session.location, workspaceID: "workspace" } },
  ]
  for (const change of changed) expect(sameSession(session, { ...session, ...change })).toBe(false)
})
