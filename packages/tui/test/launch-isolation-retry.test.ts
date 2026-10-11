import { expect, test } from "bun:test"
import { dashboard, globalEvents, session, until } from "./support"

for (const mode of ["changed", "unchanged", "failed"] as const) {
  test(`${mode} Directory retry preserves isolation after ready worktree validation fails`, async () => {
    const prepared: { base: string; name: string; directory: string }[] = []
    const discovery = { broken: true }
    const events = globalEvents()
    const app = await dashboard({
      "GET /global/event": events.route,
      "GET /api/agent": (_, url) => {
        const directory = url.searchParams.get("location[directory]") ?? ""
        if (discovery.broken && prepared.some((item) => item.directory === directory))
          return new Response("validation failed", { status: 500 })
        return { location: { directory }, data: [] }
      },
      "POST /experimental/worktree": async (request, url) => {
        const name = ((await request.json()) as { name: string }).name
        const worktree = {
          base: url.searchParams.get("directory")!,
          name,
          directory: `/srv/wt/${name}`,
        }
        prepared.push(worktree)
        return { name, directory: worktree.directory }
      },
      "GET /experimental/worktree/status": (_, url) => {
        const worktree = prepared.find((item) => item.name === url.searchParams.get("name"))
        if (!worktree) return { status: "unknown" }
        if (mode === "failed" && prepared.length > 1) return { status: "failed", message: "bootstrap failed" }
        return { status: "ready", directory: worktree.directory }
      },
      "POST /api/session": async (request) => {
        const body = (await request.json()) as Record<string, unknown>
        return { data: { ...session(), id: body.id, location: body.location } }
      },
    })
    app.view.mockInput.pressKey("n")
    await app.screen("What would you like to do?")
    await app.view.mockInput.typeText("Keep isolation on retry")
    for (let step = 0; step < 4; step++) {
      app.view.mockInput.pressTab()
      await app.view.renderOnce()
    }
    app.view.mockInput.pressArrow("down")
    await app.screen("▶ New git worktree")
    app.view.mockInput.pressKey("s", { ctrl: true })
    await app.screen("HTTP 500")
    expect(prepared).toHaveLength(1)
    expect(app.server.sent("/api/session").filter((item) => item.method === "POST")).toHaveLength(0)
    discovery.broken = false
    if (mode !== "unchanged") {
      // Workspace has focus. Shift+Tab crosses Model and Agent to reach Directory.
      for (let step = 0; step < 3; step++) {
        app.view.mockInput.pressTab({ shift: true })
        await app.view.renderOnce()
      }
      app.view.mockInput.pressKey("a", { ctrl: true })
      for (const _ of prepared[0]!.directory) app.view.mockInput.pressKey("DELETE")
      await app.view.mockInput.typeText("/srv/other")
      await app.screen("/srv/other")
    }
    app.view.mockInput.pressKey("s", { ctrl: true })
    if (mode === "failed") {
      await app.screen("bootstrap failed")
      expect(prepared).toHaveLength(2)
      expect(prepared[1]!.base).toBe("/srv/other")
      expect(app.server.sent("/api/session").filter((item) => item.method === "POST")).toHaveLength(0)
      return
    }
    await until(() => app.server.sent("/api/session").some((item) => item.method === "POST"))
    expect(prepared).toHaveLength(mode === "changed" ? 2 : 1)
    if (mode === "changed") {
      expect(prepared[1]!.base).toBe("/srv/other")
      expect(prepared[1]!.name).not.toBe(prepared[0]!.name)
    }
    expect(app.server.sent("/api/session").find((item) => item.method === "POST")?.body).toMatchObject({
      location: { directory: prepared.at(-1)!.directory },
    })
  })
}
