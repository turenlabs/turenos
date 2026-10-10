import { expect, test } from "bun:test"
import { SessionListRenderable } from "../src/session-list"
import { KeyEvent, SelectRenderable, TextareaRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { mountDashboard } from "../src/index"
import { matchesKey, printableKey } from "../src/keys"
import { cleanup, waitForFrame, leaveComposer, clickText, descendants, fixture } from "./dashboard-fixture"

test("shortcut matching requires exact modifiers and normalizes Enter aliases", () => {
  const key = (name: string, modifiers: Partial<KeyEvent> = {}) =>
    new KeyEvent({
      name,
      sequence: name,
      raw: name,
      ctrl: false,
      meta: false,
      option: false,
      shift: false,
      number: false,
      eventType: "press",
      source: "raw",
      ...modifiers,
    })
  for (const name of ["enter", "return", "kpenter", "linefeed"]) {
    expect(matchesKey(key(name), "enter")).toBe(true)
    expect(matchesKey(key(name, { ctrl: true }), "enter", { ctrl: true })).toBe(true)
  }
  for (const modifier of ["shift", "meta", "option", "super", "hyper"] as const) {
    expect(matchesKey(key("s", { ctrl: true, [modifier]: true }), "s", { ctrl: true })).toBe(false)
    expect(matchesKey(key("f4", { [modifier]: true }), "f4")).toBe(false)
  }
  expect(matchesKey(key("left", { meta: true, option: true }), "left", { meta: true })).toBe(true)
  expect(matchesKey(key("s", { ctrl: true, eventType: "release" }), "s", { ctrl: true })).toBe(false)
  expect(printableKey(key("/", { shift: true, sequence: "?" }))).toBe("?")
  expect(printableKey(key("[", { shift: true, sequence: "{" }))).toBe("{")
  expect(printableKey(key("?", { super: true }))).toBe("")
})

test("extra modifiers do not quit, open commands, create drafts, toggle sidebar, or switch sessions", async () => {
  const server = fixture()
  server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Second session" })
  const view = await createTestRenderer({ width: 120, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  const list = descendants(view.renderer.root).find((node) => node instanceof SessionListRenderable)!
  for (const modifier of ["shift", "meta", "super", "hyper"] as const) {
    for (const name of ["c", "n", "k", "p", "b"]) view.mockInput.pressKey(name, { ctrl: true, [modifier]: true })
    expect(view.renderer.isDestroyed).toBe(false)
    expect(view.renderer.currentFocusedRenderable).toBe(list)
  }
  for (const modifier of ["ctrl", "shift", "super", "hyper"] as const) {
    view.mockInput.pressArrow("right", { meta: true, [modifier]: true })
    view.mockInput.pressArrow("left", { meta: true, [modifier]: true })
    expect(list.getSelectedIndex()).toBe(0)
  }
  for (const modifier of ["shift", "meta", "super", "hyper"] as const) {
    for (const name of ["q", "n", "m", "b", "2"]) view.mockInput.pressKey(name, { [modifier]: true })
    expect(view.renderer.isDestroyed).toBe(false)
    expect(view.renderer.currentFocusedRenderable).toBe(list)
  }
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("Switch session")
  expect(server.reads).not.toContain("/api/session/ses_second/message")
  expect(server.posts).toHaveLength(0)
})

for (const shortcut of ["n", "f"] as const) {
  test(`${shortcut} preserves native editing and keeps its draft through Escape then hopping; only F4 discards`, async () => {
    const server = fixture()
    server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Second session" })
    const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    view.mockInput.pressKey(shortcut)
    await view.mockInput.typeText("alpha beta")
    const editor = view.renderer.currentFocusedEditor!
    expect(editor).toBeInstanceOf(TextareaRenderable)
    view.mockInput.pressArrow("left", { meta: true })
    expect(editor.cursorOffset).toBeGreaterThan(0)
    expect(editor.cursorOffset).toBeLessThan(10)
    view.mockInput.pressArrow("right", { meta: true })
    expect(editor.cursorOffset).toBe(10)
    view.mockInput.pressKey("a", { ctrl: true })
    expect(editor.cursorOffset).toBe(0)
    view.mockInput.pressKey("d", { ctrl: true })
    expect(editor.plainText).toBe("lpha beta")
    view.mockInput.pressArrow("right")
    view.mockInput.pressArrow("right")
    // The launch form's editor keeps Ctrl+K as delete-to-line-end; the reply editor gives it to the session picker.
    if (shortcut === "n") view.mockInput.pressKey("k", { ctrl: true })
    else for (let step = 0; step < 7; step++) view.mockInput.pressKey("DELETE")
    expect(editor.plainText).toBe("lp")
    expect(view.renderer.currentFocusedEditor).toBe(editor)
    for (const modifier of ["shift", "meta", "super", "hyper"] as const) {
      view.mockInput.pressKey("s", { ctrl: true, [modifier]: true })
      view.mockInput.pressEnter({ ctrl: true, [modifier]: true })
      view.mockInput.pressKey("l", { ctrl: true, [modifier]: true })
      view.mockInput.pressKey("t", { ctrl: true, [modifier]: true })
    }
    for (const modifier of ["ctrl", "shift", "meta", "super", "hyper"] as const) {
      view.mockInput.pressKey("F4", { [modifier]: true })
      view.mockInput.pressEscape({ [modifier]: true })
    }
    for (const modifier of ["ctrl", "meta", "super", "hyper"] as const) view.mockInput.pressTab({ [modifier]: true })
    expect(view.renderer.currentFocusedEditor).toBe(editor)
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("F4 discard")
    if (shortcut === "f") expect(view.captureCharFrame()).toContain("Steer · agent is working")
    expect(server.posts).toHaveLength(0)
    view.mockInput.pressArrow("left")
    expect(editor.cursorOffset).toBe(1)
    view.mockInput.pressEscape()
    view.mockInput.pressArrow("right", { meta: true })
    await waitForFrame(view, (frame) => frame.includes("Second session"))
    view.mockInput.pressArrow("left", { meta: true })
    view.mockInput.pressKey(shortcut)
    expect(view.renderer.currentFocusedEditor?.plainText).toBe("lp")
    expect(view.renderer.currentFocusedEditor?.cursorOffset).toBe(1)
    await view.mockInput.typeText("X")
    expect(view.renderer.currentFocusedEditor?.plainText).toBe("lXp")
    view.mockInput.pressKey("F4")
    await waitForFrame(view, (frame) => frame.includes("Local draft discarded"))
    // Discarding a reply leaves its editor open and empty; the launch editor closes.
    if (shortcut === "f") await leaveComposer(view)
    view.mockInput.pressKey(shortcut)
    expect(view.renderer.currentFocusedEditor?.plainText).toBe("")
    expect(server.posts).toHaveLength(0)
  })
}

test("Ctrl+K and Alt arrows keep native editing in blocked dialogs and inline search", async () => {
  const server = fixture()
  server.sessions.push({ ...server.sessions[0]!, id: "ses_second", title: "Second session" })
  const view = await createTestRenderer({ width: 120, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  for (const context of ["kill", "search"]) {
    if (context === "kill") {
      view.mockInput.pressKey("p", { ctrl: true })
      await view.mockInput.typeText("kill")
      view.mockInput.pressEnter()
      await waitForFrame(view, (frame) => frame.includes("Confirmation (type kill)"))
    }
    if (context === "search") {
      view.mockInput.pressKey("2")
      view.mockInput.pressKey("/")
    }
    await view.mockInput.typeText("alpha beta")
    const input = view.renderer.currentFocusedEditor!
    view.mockInput.pressArrow("left", { meta: true })
    expect(input.cursorOffset).toBeGreaterThan(0)
    expect(input.cursorOffset).toBeLessThan(10)
    view.mockInput.pressArrow("right", { meta: true })
    expect(input.cursorOffset).toBe(10)
    view.mockInput.pressKey("a", { ctrl: true })
    view.mockInput.pressKey("k", { ctrl: true })
    expect(input.plainText).toBe("")
    expect(view.renderer.currentFocusedEditor).toBe(input)
    view.mockInput.pressEscape()
  }
  expect(server.reads).not.toContain("/api/session/ses_second/message")
  expect(server.posts).toHaveLength(0)
})

test("model picker repairs loading and empty selections, keeps Ctrl+A editing, and uses exact F2 setup", async () => {
  const server = fixture({ providerDelay: 50 })
  const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
  view.mockInput.pressKey("m")
  view.mockInput.pressArrow("down")
  await waitForFrame(view, (frame) => frame.includes("Catalog Model"))
  const select = descendants(view.renderer.root)
    .filter((node) => node instanceof SelectRenderable)
    .at(-1)!
  expect(select.getSelectedIndex()).toBe(0)
  await view.mockInput.typeText("nothing-matches")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  const input = view.renderer.currentFocusedEditor!
  view.mockInput.pressKey("a", { ctrl: true })
  expect(input.cursorOffset).toBe(0)
  view.mockInput.pressKey("k", { ctrl: true })
  expect(input.plainText).toBe("")
  expect(select.getSelectedIndex()).toBe(0)
  for (const modifier of ["ctrl", "shift", "meta", "super", "hyper"] as const) {
    view.mockInput.pressKey("F2", { [modifier]: true })
    view.mockInput.pressEnter({ [modifier]: true })
    expect(view.renderer.currentFocusedEditor).toBe(input)
  }
  expect(server.posts).toHaveLength(0)
  view.mockInput.pressKey("F2")
  await waitForFrame(view, (frame) => frame.includes("Connect a provider"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => frame.includes("Catalog Model"))
  view.mockInput.pressKey("\x1b[57414u")
  await waitForFrame(view, (frame) => frame.includes("Model selected for"))
  expect(server.posts).toHaveLength(1)
})

for (const picker of ["k", "p"] as const) {
  test(`${picker} picker recovers from empty results and shows a selectable first row`, async () => {
    const server = fixture()
    const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    view.mockInput.pressKey(picker, { ctrl: true })
    await view.mockInput.typeText("nothing-matches")
    view.mockInput.pressArrow("down")
    view.mockInput.pressEnter()
    view.mockInput.pressKey("u", { ctrl: true })
    if (picker === "p") {
      const select = descendants(view.renderer.root)
        .filter((node) => node instanceof SelectRenderable)
        .at(-1)!
      expect(select.getSelectedIndex()).toBe(0)
      await view.mockInput.typeText("Switch session")
      expect(select.options[select.getSelectedIndex()]?.name).toBe("Switch session  · Jump to a session (Ctrl+K)")
    }
    if (picker === "k") {
      await view.renderOnce()
      expect(view.captureCharFrame()).toContain("▶ * Review the server")
      expect(view.renderer.currentFocusedEditor?.plainText).toBe("")
    }
    view.mockInput.pressKey("LINEFEED")
    await waitForFrame(view, (frame) =>
      picker === "p"
        ? frame.includes("Switch session") && !frame.includes("Commands")
        : !frame.includes("Switch session"),
    )
    expect(server.posts).toHaveLength(0)
  })
}

for (const shortcut of ["n", "f"] as const) {
  for (const [name, enter] of [
    ["Return", "\r"],
    ["keypad Enter", "\x1b[57414u"],
    ["linefeed", "\n"],
  ] as const) {
    test(`${shortcut}: plain ${name} sends the focused composer without appending a newline`, async () => {
      const server = fixture()
      const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
      cleanup.push(() => view.renderer.destroy())
      await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
      view.mockInput.pressKey(shortcut)
      await view.mockInput.typeText("Send this exact text")
      const editor = view.renderer.currentFocusedEditor!
      expect(editor).toBeInstanceOf(TextareaRenderable)
      expect(editor.cursorOffset).toBe(editor.plainText.length)
      await view.renderOnce()
      expect(view.captureCharFrame()).toContain("Enter send")
      expect(view.captureCharFrame()).not.toContain("Ctrl+S Send")
      await view.mockInput.pressKeys([enter])
      await waitForFrame(view, (frame) => frame.includes(shortcut === "n" ? "Task sent." : "Reply sent."))
      expect(server.posts).toHaveLength(shortcut === "n" ? 2 : 1)
      expect(server.posts.filter((post) => post.path.endsWith("/prompt"))).toEqual([
        expect.objectContaining({ body: expect.objectContaining({ prompt: { text: "Send this exact text" } }) }),
      ])
    })
  }

  for (const [name, shift, alt, send] of [
    ["Return", "\x1b[13;2u", "\x1b[13;3u", "\x1b[13;5u"],
    ["keypad Enter", "\x1b[57414;2u", "\x1b[57414;3u", "\x1b[57414;5u"],
  ] as const) {
    test(`${shortcut}: Shift/Alt+${name} insert newlines and explicit send preserves the multiline text`, async () => {
      const server = fixture()
      const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
      cleanup.push(() => view.renderer.destroy())
      await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
      view.mockInput.pressKey(shortcut)
      await view.mockInput.typeText("first")
      await view.mockInput.pressKeys([shift])
      expect(view.renderer.currentFocusedEditor?.plainText).toBe("first\n")
      await view.mockInput.typeText("second")
      await view.mockInput.pressKeys([alt])
      expect(view.renderer.currentFocusedEditor?.plainText).toBe("first\nsecond\n")
      await view.mockInput.typeText("third")
      await view.renderOnce()
      expect(server.posts).toHaveLength(0)
      await view.mockInput.pressKeys([send])
      await waitForFrame(view, (frame) => frame.includes(shortcut === "n" ? "Task sent." : "Reply sent."))
      expect(server.posts).toHaveLength(shortcut === "n" ? 2 : 1)
      expect(server.posts.at(-1)?.body).toMatchObject({ prompt: { text: "first\nsecond\nthird" } })
    })
  }

  test(`${shortcut}: Enter aliases on empty or whitespace-only text never POST and leave the draft editable`, async () => {
    const server = fixture()
    const view = await createTestRenderer({ width: 60, height: 24, kittyKeyboard: true })
    cleanup.push(() => view.renderer.destroy())
    await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
    await leaveComposer(view)
    view.mockInput.pressKey(shortcut)
    const editor = view.renderer.currentFocusedEditor!
    for (const text of ["", "   "]) {
      await view.mockInput.typeText(text)
      for (const enter of ["\r", "\n", "\x1b[57414u"]) {
        await view.mockInput.pressKeys([enter])
        await waitForFrame(view, (frame) =>
          frame.includes(shortcut === "n" ? "Enter a task for the agent." : "Enter a message between"),
        )
        expect(editor.plainText).toBe(text)
        expect(view.renderer.currentFocusedEditor).toBe(editor)
        expect(server.posts).toHaveLength(0)
      }
    }
    await view.mockInput.typeText("Still editable")
    expect(editor.plainText).toBe("   Still editable")
  })

  test(`${shortcut}: multiline bracketed paste including a trailing newline never sends until Enter`, async () => {
    const server = fixture()
    const view = await createTestRenderer({ width: 60, height: 24 })
    cleanup.push(() => view.renderer.destroy())
    const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
    await app.ready
    await leaveComposer(view)
    view.mockInput.pressKey(shortcut)
    const editor = view.renderer.currentFocusedEditor!
    const text = "first\nsecond\npasted third\npasted fourth\n"
    await view.mockInput.pasteBracketedText(text)
    await app.refresh()
    await view.renderOnce()
    expect(view.renderer.currentFocusedEditor).toBe(editor)
    expect(editor.plainText).toBe(text)
    expect(editor.cursorOffset).toBe(text.length)
    expect(view.captureCharFrame()).toContain("pasted fourth")
    expect(server.posts).toHaveLength(0)
    view.mockInput.pressEnter()
    await waitForFrame(view, (frame) => frame.includes(shortcut === "n" ? "Task sent." : "Reply sent."))
    expect(server.posts).toHaveLength(shortcut === "n" ? 2 : 1)
    expect(server.posts.at(-1)?.body).toMatchObject({ prompt: { text } })
  })

  for (const width of [60, 120]) {
    test(`${shortcut}: ${shortcut === "n" ? "the Send button submits on left click" : "the reply editor has no Send button and sends on Enter"} at ${width} columns`, async () => {
      const server = fixture()
      const view = await createTestRenderer({ width, height: 24 })
      cleanup.push(() => view.renderer.destroy())
      await mountDashboard(view.renderer, server.connection, server.server.url.href).ready
      // A narrow terminal starts with the reply editor already open.
      if (width === 60) await leaveComposer(view)
      view.mockInput.pressKey(shortcut)
      await view.mockInput.typeText("Send by mouse")
      await view.renderOnce()
      const button = descendants(view.renderer.root).find(
        (node) => node instanceof TextRenderable && node.plainText === "[ Send (Enter) ]",
      )
      if (shortcut === "f") {
        expect(button).toBeUndefined()
        expect(view.captureCharFrame()).not.toContain("Your message")
        const row = view
          .captureCharFrame()
          .split("\n")
          .findIndex((line) => line.includes("Send by mouse"))
        await view.mockMouse.click(4, row, 2)
        await view.renderOnce()
        expect(server.posts).toHaveLength(0)
        view.mockInput.pressEnter()
      }
      if (shortcut === "n") {
        expect(button).toBeDefined()
        await view.mockMouse.click(button!.x + 2, button!.y, 2)
        await view.renderOnce()
        expect(server.posts).toHaveLength(0)
        await clickText(view, "[ Send (Enter) ]")
      }
      await waitForFrame(view, (frame) => frame.includes(shortcut === "n" ? "Task sent." : "Reply sent."))
      expect(server.posts).toHaveLength(shortcut === "n" ? 2 : 1)
      expect(server.posts.at(-1)?.body).toMatchObject({ prompt: { text: "Send by mouse" } })
    })
  }
}
