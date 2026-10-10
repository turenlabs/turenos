import { expect, test } from "bun:test"
import { agent, document, home, permission, world } from "./agent-fixture"
import { session, type Route } from "./support"

const at = (name: string, directory: string, projectID = "project") => ({
  ...session(name),
  projectID,
  location: { directory },
})

/** Sessions in a project's root folder, in one of its worktrees, and in another project's folder. */
function folders(routes: Record<string, Route> = {}) {
  return world({
    "GET /api/location": (_, url) => ({
      directory: url.searchParams.get("location[directory]") ?? "/srv/main",
      project: { id: "project", directory: "/srv/repo" },
    }),
    "GET /api/fs/list": (_, url) => ({ location: { directory: url.searchParams.get("location[directory]") }, data: [] }),
    "GET /api/session": () => ({
      data: [at("repo", "/srv/repo"), at("tree", "/data/worktree/project/fix"), at("other", "/srv/other", "other")],
      cursor: {},
    }),
    // `sessions` asks each listed session how its latest turn ended.
    ...Object.fromEntries(
      ["repo", "tree", "other"].map((name) => [`GET /api/session/ses_${name}/message`, () => ({ data: [], cursor: {} })]),
    ),
    ...routes,
  })
}

test("sessions run in a folder lists that folder and its project's worktrees; --everywhere and home list all", async () => {
  const server = folders()
  const here = await agent(["sessions"], { url: server.url, cwd: "/srv/repo" })
  expect(here.code).toBe(0)
  const lines = here.stdout.trim().split("\n")
  expect(lines[0]).toBe("folder /srv/repo · --everywhere lists every folder")
  expect(lines.slice(1).map((line) => line.split(" · ")[0])).toEqual(["ses_repo", "ses_tree"])
  expect(document(await agent(["sessions", "--json"], { url: server.url, cwd: "/srv/repo" })).folder).toBe("/srv/repo")
  for (const run of [
    await agent(["sessions", "--everywhere"], { url: server.url, cwd: "/srv/repo" }),
    await agent(["sessions"], { url: server.url, cwd: home }),
  ]) {
    expect(run.stdout).not.toContain("folder ")
    expect(run.stdout).toContain("ses_other")
  }
})

test("a folder the server cannot read lists every folder, with a note on stderr", async () => {
  const server = folders({ "GET /api/fs/list": () => new Response(null, { status: 404 }) })
  const run = await agent(["sessions"], { url: server.url, cwd: "/srv/gone" })
  expect(run.code).toBe(0)
  expect(run.stderr).toBe("turen-tui: /srv/gone is not readable on this server; listing every folder.\n")
  expect(run.stdout).toContain("ses_other")
  const named = await agent(["sessions", "--dir", "/srv/gone"], { url: server.url })
  expect(named.code).toBe(1)
  expect(named.stderr).toContain("Folder not found on the server.")
})

test("send --new starts in the folder it runs in; --dir still wins", async () => {
  const created: { location: unknown }[] = []
  const server = folders({
    "POST /api/session": async (request) => {
      const body = (await request.json()) as { id: string; location: unknown }
      created.push(body)
      return { data: { ...session("new"), id: body.id, location: body.location } }
    },
    "POST /api/session/ses_fresh/prompt": async (request) => ({
      data: { id: ((await request.json()) as { id: string }).id, sessionID: "ses_fresh" },
    }),
  })
  const send = (extra: string[]) =>
    agent(["send", "--new", "hello", "--session-id", "ses_fresh", ...extra], { url: server.url, cwd: "/srv/repo" })
  expect((await send([])).code).toBe(0)
  expect((await send(["--dir", "/srv/other"])).code).toBe(0)
  expect(created.map((body) => body.location)).toEqual([{ directory: "/srv/repo" }, { directory: "/srv/other" }])
})

test("pending run in a folder lists only the requests of that folder's running sessions", async () => {
  const server = folders({
    "GET /api/session/ses_main": () => ({ data: at("main", "/srv/repo/app") }),
    "GET /api/session/ses_away": () => ({ data: at("away", "/srv/other", "other") }),
    "GET /api/session/ses_away/permission": () => ({ data: [permission("per_away", { sessionID: "ses_away" })] }),
    "GET /api/session/ses_away/question": () => ({ data: [] }),
  })
  server.state.active.add("ses_main")
  server.state.active.add("ses_away")
  server.state.permissions.push(permission("per_main"))
  const here = await agent(["pending"], { url: server.url, cwd: "/srv/repo" })
  expect(here.stdout).toContain("per_main")
  expect(here.stdout).not.toContain("per_away")
  const everywhere = await agent(["pending", "--everywhere"], { url: server.url, cwd: "/srv/repo" })
  expect(everywhere.stdout).toContain("per_away")
  const quiet = await agent(["pending", "--dir", "/srv/other/none"], { url: server.url })
  expect(quiet.stdout).toBe("Nothing is pending in a running session in /srv/other/none.\n")
})
