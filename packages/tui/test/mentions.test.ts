import { afterEach, expect, test } from "bun:test"
import { KeyEvent, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createMentions } from "../src/mentions"
import { mentionText, parseMentions, promptPayload } from "../src/prompt-files"
import { connect } from "../src/server"
import { createDashboardState } from "../src/state"

type Entry = { path: string; type: "file" | "directory" }

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function key(name: string, modifiers: Partial<KeyEvent> = {}) {
  return new KeyEvent({
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
}

test("mentions become absolute file URIs with ranges, and unmentioned prompts keep their original body", () => {
  expect(promptPayload("plain task with a@b.example and /usr/file", "/srv/project")).toEqual({
    text: "plain task with a@b.example and /usr/file",
  })
  expect(promptPayload("look at @src/auth.ts please", "/srv/project/")).toEqual({
    text: "look at @src/auth.ts please",
    files: [
      {
        uri: "file:///srv/project/src/auth.ts",
        name: "auth.ts",
        source: { start: 8, end: 20, text: "@src/auth.ts" },
      },
    ],
  })
  expect(promptPayload("@src/a.ts#20-45 and @src/a.ts#20-45 and @/etc/hosts", "/srv/project").files).toEqual([
    {
      uri: "file:///srv/project/src/a.ts?start=20&end=45",
      name: "a.ts",
      source: { start: 0, end: 15, text: "@src/a.ts#20-45" },
    },
    { uri: "file:///etc/hosts", name: "hosts", source: { start: 40, end: 51, text: "@/etc/hosts" } },
  ])
  // A single line number is an inclusive one-line range.
  expect(promptPayload("@a.ts#7", "/srv/p").files?.[0]?.uri).toBe("file:///srv/p/a.ts?start=7&end=7")
  // Spaces and quotes close a mention so surrounding prose is not absorbed.
  expect(promptPayload('("@src/a.ts") next', "/srv/p").files?.[0]?.source.text).toBe("@src/a.ts")
  expect(promptPayload("see @src/a.ts.", "/srv/p").files?.[0]?.name).toBe("a.ts")
  expect(promptPayload("@a b.ts", "/srv/p").files?.[0]?.uri).toBe("file:///srv/p/a")
})

test("a quoted mention carries paths the bare grammar would truncate, and completion round-trips", () => {
  // Each of these ends a bare mention early, so completing it unquoted would
  // attach a shorter path - and `src/lib` is a different real file from `src/lib[2].ts`.
  // `src/v#` and `notes#a-b` read as malformed ranges when bare, so they must be quoted too.
  const quoted = [
    "src/app/(auth)/page.tsx",
    "src/lib[2].ts",
    "my notes.md",
    "a'b.ts",
    "weird.",
    "src/v#2",
    "{b}.ts",
    "src/v#",
    "notes#a-b",
    "x#5-",
  ]
  // These are safe bare even though they contain awkward characters.
  const bare = ["src/auth.ts", "src/v#2.ts", "a-b_c.2.tsx"]
  for (const path of quoted) expect(mentionText(path)).toBe(`@"${path}"`)
  for (const path of bare) expect(mentionText(path)).toBe(`@${path}`)
  // Whatever form completion picks must parse back to exactly that path.
  for (const path of [...quoted, ...bare]) {
    const text = mentionText(path)!
    const files = parseMentions(`see ${text} now`, "/srv/p")
    expect(files).toHaveLength(1)
    expect(decodeURIComponent(new URL(files[0]!.uri).pathname)).toBe(`/srv/p/${path}`)
    expect(files[0]!.source.text).toBe(text)
    expect(`see ${text} now`.slice(files[0]!.source.start, files[0]!.source.end)).toBe(text)
  }
  // A quoted mention takes its range after the closing quote.
  expect(parseMentions('@"my notes.md"#3-9', "/srv/p")[0]!.uri).toBe("file:///srv/p/my%20notes.md?start=3&end=9")
  expect(parseMentions('@"my notes.md"#3-9', "/srv/p")[0]!.source).toEqual({
    start: 0,
    end: 18,
    text: '@"my notes.md"#3-9',
  })
  // A path the grammar cannot represent is refused rather than mis-attached.
  expect(mentionText('say"hi.ts')).toBeUndefined()
  expect(mentionText("bad\u0007.ts")).toBeUndefined()
})

test("quoted ranges consume the entire suffix instead of attaching a valid prefix", () => {
  for (const suffix of ["#3-", "#3-nope", "#3-9oops", "#3-9-10", "#nope", "#3#4"]) {
    const text = `@"a.ts"${suffix} and @"b.ts"#2-4.`
    expect(parseMentions(text, "/srv/p").map((file) => file.uri)).toEqual(["file:///srv/p/b.ts?start=2&end=4"])
  }
})

test("mentions preserve POSIX literal backslashes and normalize Windows separators", () => {
  expect(parseMentions(mentionText("a\\b.ts")!, "/srv/p")[0]).toMatchObject({
    uri: "file:///srv/p/a%5Cb.ts",
    name: "a\\b.ts",
  })
  expect(parseMentions("@a.ts", "/srv/p\\")[0]?.uri).toBe("file:///srv/p%5C/a.ts")
  expect(parseMentions(mentionText("src\\a.ts")!, "C:\\repo")[0]).toMatchObject({
    uri: "file:///C:/repo/src/a.ts",
    name: "a.ts",
  })
  expect(parseMentions('@"\\\\host\\share\\a b.ts"#2', "/srv/p")[0]).toMatchObject({
    uri: "file:////host/share/a%20b.ts?start=2&end=2",
    name: "a b.ts",
  })
})

test("malformed mentions are dropped rather than attached, and the count is bounded", () => {
  for (const text of ["@a.ts#0", "@a.ts#9-2", "@a.ts#99999999999999999999", `@${"x".repeat(5000)}`, "@\u0007bad"]) {
    expect(promptPayload(text, "/srv/p")).toEqual({ text })
  }
  // A second `#` suffix is never folded into a different range or file; only the quoted form can name such a path.
  for (const text of ['@"secret.txt"#123#456', '@"secret.txt"#1-', "@secret.txt#123#456", "@secret.txt#1-"]) {
    expect(promptPayload(text, "/srv/p")).toEqual({ text })
  }
  expect(parseMentions('@"secret.txt"#12 @b.ts#12-20', "/srv/p").map((file) => file.uri)).toEqual([
    "file:///srv/p/secret.txt?start=12&end=12",
    "file:///srv/p/b.ts?start=12&end=20",
  ])
  const many = Array.from({ length: 40 }, (_, index) => `@f${index}.ts`).join(" ")
  expect(promptPayload(many, "/srv/p").files).toHaveLength(32)
})

function transport(routes: (url: URL) => Response) {
  const calls: { url: URL; method: string; body: Record<string, unknown> }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      calls.push({
        url,
        method: request.method,
        body: request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {},
      })
      return routes(url)
    },
  })
  const connection = connect({ url: server.url.href })
  cleanup.push(async () => {
    connection.close()
    await server.stop(true)
  })
  return { connection, calls }
}

test("file search forwards its location and refuses results that escape the requested directory", async () => {
  const entries: Entry[] = [
    { path: "src/auth.ts", type: "file" },
    { path: "src", type: "directory" },
  ]
  let data: unknown = entries
  const { connection, calls } = transport(() =>
    Response.json({ location: { directory: "/srv/project", project: { id: "prj", directory: "/srv/project" } }, data }),
  )
  expect(await connection.findFiles("/srv/project", "auth", "wrk_project")).toEqual(entries)
  expect(calls[0]!.url.pathname).toBe("/api/fs/find")
  expect(calls[0]!.url.searchParams.get("location[directory]")).toBe("/srv/project")
  expect(calls[0]!.url.searchParams.get("location[workspace]")).toBe("wrk_project")
  expect(calls[0]!.url.searchParams.get("query")).toBe("auth")
  expect(calls[0]!.url.searchParams.get("limit")).toBe("50")
  // Each of these would otherwise become a file:// attachment outside the location.
  for (const path of ["/etc/hosts", "../secrets.env", "src/../../etc/hosts", "C:\\Windows\\hosts", "a\u001b[0m.ts"]) {
    data = [{ path, type: "file" }]
    await expect(connection.findFiles("/srv/project", "x")).rejects.toMatchObject({
      cause: { message: "Invalid server response (file path)." },
    })
  }
  await expect(connection.findFiles("/srv/project", "x".repeat(513))).rejects.toThrow("below 512 characters")
  expect(calls.filter((call) => call.url.pathname === "/api/fs/find")).toHaveLength(6)
})

test("a shell command posts the caller's message ID and rejects a substituted acknowledgement", async () => {
  let id: unknown = "msg_shell"
  const { connection, calls } = transport((url) => {
    if (!url.pathname.endsWith("/shell")) return new Response("unexpected", { status: 404 })
    return Response.json({ data: { id, type: "shell", command: "ls -la", output: "", status: "running" } })
  })
  expect(await connection.shell("ses_test", "msg_shell", "ls -la")).toMatchObject({ id: "msg_shell" })
  expect(calls[0]!.url.pathname).toBe("/api/session/ses_test/shell")
  expect(calls[0]!.body).toEqual({ id: "msg_shell", command: "ls -la" })
  id = "msg_other"
  await expect(connection.shell("ses_test", "msg_shell", "ls -la")).rejects.toMatchObject({
    cause: { message: "Invalid server response (shell message identity)." },
  })
  await expect(connection.shell("ses_test", "msg_shell", "   ")).rejects.toThrow("Enter a command")
})

async function picker(entries: () => Promise<Entry[]>) {
  const view = await createTestRenderer({ width: 90, height: 32 })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  const dialogs = createDialogs(view.renderer, state, createLayout(view.renderer, state), {
    rememberPosition() {},
    cancelPosition() {},
    changed() {},
    async submitted() {},
    say() {},
  })
  const dialog = dialogs.open("Compose")!
  const editor = dialogs.prompt(dialog, "Message")
  const calls: unknown[][] = []
  const mentions = createMentions(view.renderer, state, {
    findFiles: async (...args) => {
      calls.push(args)
      return entries()
    },
  })
  mentions.attach(dialog, editor, () => ({ directory: "/srv/project", workspaceID: "wrk" }))
  editor.focus()
  const suggestions = dialog.form.getChildren().find((child) => child.id === `${editor.id}-mentions`) as TextRenderable
  return {
    view,
    dialogs,
    dialog,
    editor,
    mentions,
    suggestions,
    calls,
    // Type through real key input so the cursor advances with the text; the
    // mention trigger is cursor-relative, unlike whole-text slash matching.
    async type(text: string) {
      editor.setText("")
      editor.cursorOffset = 0
      await view.mockInput.typeText(text)
      await new Promise((resolve) => setTimeout(resolve, 320))
      await view.renderOnce()
    },
    async append(text: string) {
      await view.mockInput.typeText(text)
      await new Promise((resolve) => setTimeout(resolve, 320))
      await view.renderOnce()
    },
  }
}

test("@ searches the server, completes files and directories, and leaves ordinary text alone", async () => {
  const f = await picker(async () => [
    { path: "src/auth.ts", type: "file" },
    { path: "src/lib", type: "directory" },
  ])
  await f.type("read this")
  expect(f.suggestions.visible).toBe(false)
  expect(f.calls).toEqual([])

  await f.type("look at @au")
  expect(f.calls.at(-1)?.slice(0, 3)).toEqual(["/srv/project", "au", "wrk"])
  expect(f.suggestions.visible).toBe(true)
  expect(f.dialog.mentionRows).toBe(2)
  // Typing a whole path must not issue one recursive search per keystroke.
  expect(f.calls.length).toBeLessThanOrEqual(2)

  // A file ends the mention and leaves a trailing space for more prose.
  expect(f.mentions.key(key("tab"))).toBe(true)
  expect(f.editor.plainText).toBe("look at @src/auth.ts ")
  expect(f.suggestions.visible).toBe(false)

  // A directory keeps the list open so its next segment can be searched.
  await f.type("look at @au")
  expect(f.mentions.key(key("down"))).toBe(true)
  expect(f.mentions.key(key("enter"))).toBe(true)
  expect(f.editor.plainText).toBe("look at @src/lib/")
  expect(f.suggestions.visible).toBe(true)

  // Escape dismisses the list without closing the dialog or editing the draft.
  expect(f.mentions.key(key("escape"))).toBe(true)
  expect(f.suggestions.visible).toBe(false)
  expect(f.editor.plainText).toBe("look at @src/lib/")
  expect(f.dialog.mentionRows).toBe(0)
  expect(f.dialog.box.isDestroyed).toBe(false)
  // The dismissal holds for this mention: Enter goes to the dialog instead of reopening the search.
  expect(f.mentions.key(key("enter"))).toBe(false)
  expect(f.suggestions.visible).toBe(false)
  expect(f.dialog.mentionRows).toBe(0)

  // Typing a path searches, but a `#` range addresses an already-chosen file and
  // must neither search again nor offer to replace the path.
  await f.type("look at @src/auth.ts#12")
  expect(f.suggestions.visible).toBe(false)
  const before = f.calls.length
  await f.append("-20")
  expect(f.suggestions.visible).toBe(false)
  expect(f.calls).toHaveLength(before)
  expect(f.editor.plainText).toBe("look at @src/auth.ts#12-20")
})

test("completing a path with delimiters attaches that exact file, not a shorter prefix", async () => {
  const f = await picker(async () => [
    { path: "src/lib", type: "file" },
    { path: "src/lib[2].ts", type: "file" },
    { path: "src/app/(auth)", type: "directory" },
  ])
  await f.type("open @src/li")
  expect(f.mentions.key(key("down"))).toBe(true)
  expect(f.mentions.key(key("tab"))).toBe(true)
  expect(f.editor.plainText).toBe('open @"src/lib[2].ts" ')
  // The bare form would have truncated to `src/lib`, a different real file here.
  expect(parseMentions(f.editor.plainText, "/srv/project").map((file) => file.uri)).toEqual([
    "file:///srv/project/src/lib%5B2%5D.ts",
  ])

  // A quoted folder keeps the caret inside the quotes so its next segment searches.
  await f.type("open @src/ap")
  expect(f.mentions.key(key("down"))).toBe(true)
  expect(f.mentions.key(key("down"))).toBe(true)
  expect(f.mentions.key(key("enter"))).toBe(true)
  expect(f.editor.plainText).toBe('open @"src/app/(auth)/"')
  expect(f.editor.cursorOffset).toBe(f.editor.plainText.length - 1)
  await f.append("page.tsx")
  expect(f.editor.plainText).toBe('open @"src/app/(auth)/page.tsx"')
  expect(parseMentions(f.editor.plainText, "/srv/project")[0]!.uri).toBe("file:///srv/project/src/app/(auth)/page.tsx")
})

test("an unavailable file search never blocks the draft or completes a guess", async () => {
  let fail = true
  const f = await picker(async () => {
    if (fail) throw new Error("search offline")
    return [{ path: "src/auth.ts", type: "file" }]
  })
  await f.type("look at @au")
  expect(f.suggestions.plainText).toContain("File search unavailable")
  expect(f.mentions.key(key("enter"))).toBe(false)
  expect(f.mentions.key(key("tab"))).toBe(false)
  expect(f.editor.plainText).toBe("look at @au")
  fail = false
  await f.type("look at @aut")
  expect(f.mentions.key(key("tab"))).toBe(true)
  expect(f.editor.plainText).toBe("look at @src/auth.ts ")
})

test.each(["Enter", "Ctrl+Enter", "Ctrl+S", "Send"])(
  "%s keeps a pending mention search out of submission",
  async (route) => {
    const pending = Promise.withResolvers<Entry[]>()
    const f = await picker(() => pending.promise)
    const sent: string[] = []
    f.dialog.submit = async () => {
      sent.push(f.editor.plainText)
    }
    f.view.renderer.keyInput.on("keypress", (event) => {
      if (!f.mentions.key(event)) f.dialogs.keypress(event)
    })
    const send = async () => {
      if (route === "Send") await f.view.mockMouse.click(f.dialog.send!.x + 1, f.dialog.send!.y)
      if (route === "Enter") f.view.mockInput.pressEnter()
      if (route === "Ctrl+Enter") f.view.mockInput.pressEnter({ ctrl: true })
      if (route === "Ctrl+S") f.view.mockInput.pressKey("s", { ctrl: true })
      await f.view.renderOnce()
    }
    await f.type("look at @au")
    expect(f.suggestions.plainText).toContain("Searching files")
    await send()
    expect(sent).toEqual([])
    expect(f.editor.plainText).toBe("look at @au")
    pending.resolve([{ path: "src/auth.ts", type: "file" }])
    await Bun.sleep(10)
    await f.view.renderOnce()
    await send()
    expect(sent).toEqual([])
    expect(f.editor.plainText).toBe("look at @src/auth.ts ")
    await send()
    expect(sent).toEqual(["look at @src/auth.ts "])
  },
)

test.each(["", " and explain", "#12-20 and explain"])(
  "quoted folder-to-file completion preserves suffix %j",
  async (suffix) => {
    let entries: Entry[] = [{ path: "src/app/(auth)", type: "directory" }]
    const f = await picker(async () => entries)
    await f.type("open @src/ap")
    expect(f.mentions.key(key("tab"))).toBe(true)
    expect(f.editor.plainText).toBe('open @"src/app/(auth)/"')
    const cursor = f.editor.cursorOffset
    f.editor.setText(f.editor.plainText + suffix)
    f.editor.cursorOffset = cursor
    entries = [{ path: "src/app/(auth)/page.tsx", type: "file" }]
    await f.append("page")
    expect(f.mentions.key(key("tab"))).toBe(true)
    expect(f.editor.plainText).toBe(`open @"src/app/(auth)/page.tsx"${suffix || " "}`)
    expect(parseMentions(f.editor.plainText, "/srv/project").map((file) => file.uri)).toEqual([
      `file:///srv/project/src/app/(auth)/page.tsx${suffix.startsWith("#") ? "?start=12&end=20" : ""}`,
    ])
  },
)
