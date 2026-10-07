import { expect, test } from "bun:test"
import { sandbox } from "./support"

// An agent works through the non-interactive commands while a person watches the dashboard.
const tui = sandbox("agent-cli")
const state: { session?: string } = {}

test("without a terminal the dashboard points at the agent commands", async () => {
  const result = await tui.cli([])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("turen-tui --help")
})

test("send --new --wait starts a session and prints the reply", async () => {
  const result = await tui.cli(["send", "--new", "hello from an agent", "--wait", "--json"])
  expect(result.status).toBe(0)
  const output = JSON.parse(result.stdout) as { session: string; state: string }
  expect(output.state).toBe("idle")
  state.session = output.session
  expect(result.stdout).toContain("Sandbox reply to: hello from an agent")
  await tui.waitFor("hello from an agent")
})

test("a permission request stops the wait with exit 3 and the exact follow-up commands", async () => {
  const sent = await tui.cli(["send", state.session!, "please run the marker", "--wait"])
  expect(sent.status).toBe(3)
  // Anchored at two spaces: transcript text is set in by four, so a message cannot supply this line.
  const approve = sent.stdout.match(/^  approve: (turen-tui approve \S+ \S+)/m)
  expect(approve).not.toBeNull()
  await tui.waitFor("Needs input")
  const id = approve![1]!.split(" ").at(-1)!
  expect((await tui.cli(["approve", state.session!, id])).status).toBe(0)
  const waited = await tui.cli(["wait", state.session!, "--timeout", "60"])
  expect(waited.status).toBe(0)
  expect(waited.stdout).toContain("sandbox-marker")
})

test("a question is answered by label", async () => {
  const sent = await tui.cli(["send", state.session!, "ask me a colour", "--wait", "--json"])
  expect(sent.status).toBe(3)
  const pending = (JSON.parse(sent.stdout) as { pending: { questions: { id: string }[] } }).pending
  const answered = await tui.cli(["answer", state.session!, pending.questions[0]!.id, "--choice", "Blue"])
  expect(answered.status).toBe(0)
  expect((await tui.cli(["wait", state.session!, "--timeout", "60"])).status).toBe(0)
})

test("stop interrupts a running turn and show prints the whole transcript", async () => {
  expect((await tui.cli(["send", state.session!, "tell me a slow story"])).status).toBe(0)
  await tui.waitFor("word2")
  expect((await tui.cli(["stop", state.session!])).status).toBe(0)
  await tui.idle()
  const shown = await tui.cli(["show", state.session!, "--all"])
  expect(shown.status).toBe(0)
  expect(shown.stdout).toContain("hello from an agent")
  expect(shown.stdout).toContain("INTERRUPTED")
  expect(shown.stdout).not.toMatch(/\u001b\[/)
})

test("sessions --json lists the session as idle", async () => {
  const result = await tui.cli(["sessions", "--json"])
  expect(result.status).toBe(0)
  const sessions = (JSON.parse(result.stdout) as { sessions: { id: string; state: string }[] }).sessions
  expect(sessions.find((session) => session.id === state.session)?.state).toBe("idle")
})
