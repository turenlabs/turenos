import assert from "node:assert/strict"
import { mock, spyOn } from "bun:test"
import { plugin } from "bun"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { ForgeClient } from "../../../sdk/js/src/v2/gen/sdk.gen"
import { createClient } from "@turenlabs/sdk/v2/gen/client"
import type { Team } from "@turenlabs/schema/team"

const compiler = await import("@babel/core")
const preset = await import("babel-preset-solid")
plugin({
  name: "team-attachments-fixture",
  setup(build) {
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
      const result = await compiler.transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[preset.default, { generate: "dom" }]],
      })
      return { contents: result?.code ?? "", loader: "tsx" }
    })
  },
})

type Attachment = { name: string; mime: string; uri: string }
type Message = Team.Message & { attachments?: Attachment[] }

let nativeClipboard: () => Promise<File | null> = async () => null
const { ServerConnection, serverName } = await import("@/context/server")
await mock.module("@/context/server", () => ({
  ServerConnection,
  serverName,
  useServer: () => ({ current: undefined, key: "fixture", list: [] }),
}))
await mock.module("@/context/global", () => ({ useGlobal: () => ({}) }))
await mock.module("@/components/nav-rail", () => ({ useNavRail: () => ({ collapsed: () => true }) }))
await mock.module("@/context/platform", () => ({
  usePlatform: () => ({ platform: "desktop", readClipboardImage: () => nativeClipboard() }),
}))
// This fixture checks the composer and attachment rendering, not rich-output rendering.
await mock.module("@/pages/team/message-content", () => ({
  TeamMessageContent: (props: { message: Team.Message }) => {
    const node = document.createElement("p")
    node.textContent = props.message.text
    return node
  },
}))

// Happy DOM has no layout intersections; drive only that browser boundary explicitly.
const visible = new Set<() => void>()
await mock.module("@/pages/team/rich-output", () => ({
  observeTeamRichOutput: (_element: HTMLElement, ready: () => void) => {
    visible.add(ready)
    return () => visible.delete(ready)
  },
}))
const reveal = () => visible.forEach((ready) => ready())

const uri = (mime: string, text: string) => `data:${mime};base64,${btoa(text)}`
const rooms = [
  { id: "room-a", name: "First", topic: "", head: 1 },
  { id: "room-b", name: "Second", topic: "", head: 0 },
  { id: "room-c", name: "Old", topic: "", head: 1, archived: true },
]
const stored: Attachment[] = [
  { name: "pixel.png", mime: "image/png", uri: uri("image/png", "png-bytes") },
  { name: "vector.svg", mime: "image/svg+xml", uri: uri("image/svg+xml", "<svg onload='alert(1)'/>") },
  { name: "page.html", mime: "text/html", uri: uri("text/html", "<script>alert(1)</script>") },
  { name: "remote.png", mime: "image/png", uri: "https://example.com/remote.png" },
  { name: "host.png", mime: "image/png", uri: "file:///etc/passwd" },
  { name: "mismatch.png", mime: "image/png", uri: uri("image/svg+xml", "<svg/>") },
]
const messages: Message[] = [
  {
    id: "message-a",
    roomID: "room-a",
    seq: 1,
    kind: "human",
    author: "Tom",
    text: "Stored files",
    attachments: stored,
    time: 1,
  },
  {
    id: "message-c",
    roomID: "room-c",
    seq: 1,
    kind: "human",
    author: "Tom",
    text: "Archived files",
    attachments: [stored[0]!],
    time: 2,
  },
]
const posts: { id: string; roomID?: string; text: string; attachments?: Attachment[] }[] = []
const attachmentReads: string[] = []
let failPost = false
let failAttachmentRead = false
let delayedAttachmentRead: Promise<Response> | undefined
const fetcher = Object.assign(
  async (input: Parameters<typeof fetch>[0]) => {
    const request = new Request(input)
    const url = new URL(request.url)
    if (url.pathname.endsWith("/attachments")) {
      const messageID = decodeURIComponent(url.pathname.split("/").at(-2)!)
      attachmentReads.push(messageID)
      if (failAttachmentRead) return Response.json({ message: "Unavailable" }, { status: 500 })
      if (delayedAttachmentRead) {
        const pending = delayedAttachmentRead
        delayedAttachmentRead = undefined
        return pending
      }
      const message = messages.find((item) => item.id === messageID && item.roomID === url.searchParams.get("roomID"))
      return message ? Response.json(message.attachments ?? []) : Response.json({ message: "Missing" }, { status: 400 })
    }
    if (url.pathname === "/api/team/message") {
      const body = await request.json()
      posts.push(body)
      if (failPost) return Response.json({ message: "Network lost" }, { status: 500 })
      const message: Message = {
        id: body.id,
        roomID: body.roomID,
        seq: messages.length + 1,
        kind: "human",
        author: "Tom",
        text: body.text,
        ...(body.attachments ? { attachments: body.attachments } : {}),
        time: 3,
      }
      messages.push(message)
      return Response.json({ message, tasks: [] })
    }
    if (url.pathname === "/api/team") {
      const roomID = url.searchParams.get("roomID")!
      return Response.json({
        room: rooms.find((room) => room.id === roomID)!,
        rooms,
        teammates: [],
        messages: messages
          .filter((message) => message.roomID === roomID && message.seq > Number(url.searchParams.get("after") ?? 0))
          .map(({ attachments, ...message }) => ({
            ...message,
            attachmentInfo: attachments?.map((file) => ({ name: file.name, mime: file.mime, size: 8 })),
          })),
        tasks: [],
        duties: [],
        factoryRuns: [],
        hasMore: false,
      })
    }
    return Response.json({ data: [] })
  },
  { preconnect() {} },
)
const server = (baseUrl: string, scope: string) => ({
  client: new ForgeClient({ client: createClient({ baseUrl, fetch: fetcher }) }),
  url: baseUrl,
  scope,
})
const [sdk, setSDK] = createSignal(server("http://team.test", "fixture"))
await mock.module("@/context/server-sdk", () => ({ useServerSDK: () => sdk }))

const interval = spyOn(window, "setInterval").mockImplementation(() => 0)
const clearInterval = spyOn(window, "clearInterval").mockImplementation(() => {})
const blobs: Blob[] = []
const objectURL = spyOn(URL, "createObjectURL").mockImplementation((blob) => {
  blobs.push(blob as Blob)
  return "blob:fixture"
})
const revokeURL = spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
const downloads: { name: string; href: string }[] = []
const anchorClick = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
  downloads.push({ name: this.download, href: this.getAttribute("href") ?? "" })
})

const { createMemoryHistory, MemoryRouter, Route } = await import("@solidjs/router")
const { default: TeamPage } = await import("@/pages/team")
const history = createMemoryHistory()
history.set({ value: "/team/room-a" })
const host = document.createElement("div")
document.body.append(host)
const dispose = render(
  () =>
    createComponent(MemoryRouter, {
      history,
      get children() {
        return createComponent(Route, { path: "/team/:roomID", component: TeamPage })
      },
    }),
  host,
)
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
async function until(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await flush()
  }
  assert.fail(`${message}\n${host.textContent}`)
}
const log = () => host.querySelector<HTMLElement>('[aria-label="Room messages"]')!
const composer = () => host.querySelector<HTMLElement>('[data-component="team-composer"]')!
const picker = () => composer().querySelector<HTMLInputElement>('input[type="file"]')!
const attach = () => composer().querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!
const sendButton = () =>
  [...composer().querySelectorAll("button")].find((button) => button.textContent?.trim().startsWith("Send"))!
const drafts = () =>
  [...composer().querySelectorAll('[data-slot="team-draft-attachment"]')].map((item) => item.getAttribute("title"))
const alertText = () => composer().querySelector('[role="alert"]')?.textContent ?? ""
const png = (name: string) => new File([Uint8Array.of(1, 2, 3, 4)], name, { type: "image/png" })
function select(files: File[]) {
  Object.defineProperty(picker(), "files", { value: files, configurable: true })
  picker().dispatchEvent(new Event("change", { bubbles: true }))
}
function drop(files: File[], text = "") {
  const event = new Event("drop", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"], getData: () => text } })
  composer().querySelector("textarea")!.dispatchEvent(event)
  return event
}
function paste(files: File[], text = "") {
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", {
    value: { items: files.map((file) => ({ kind: "file", getAsFile: () => file })), getData: () => text },
  })
  composer().querySelector("textarea")!.dispatchEvent(event)
  return event
}
// Send stays disabled while a file is still being read, so wait for the draft to settle first.
const send = async () => {
  await until(() => !sendButton().disabled, "Send was not enabled")
  sendButton().click()
}
const room = async (id: string, text: string) => {
  history.set({ value: `/team/${id}` })
  await until(() => !!host.querySelector("h2")?.textContent?.includes(text), `Room ${id} did not load`)
  await until(() => !host.textContent?.includes("Loading room history"), `Room ${id} kept loading`)
  reveal()
}

try {
  // Stored human attachments render after a reload: passive rasters inline, everything else download-only.
  await until(() => !!log()?.textContent?.includes("Stored files"), "History did not load")
  assert.deepEqual(attachmentReads, [], "Offscreen attachments were eagerly loaded")
  reveal()
  await until(() => !!log().querySelector('img[alt="pixel.png"]'), "Stored attachment bytes did not load")
  assert.deepEqual(attachmentReads, ["message-a"], "History attachments were not loaded through the scoped API")
  const article = log().querySelector("article")!
  const images = [...article.querySelectorAll("img")]
  assert.deepEqual(
    images.map((image) => [image.getAttribute("alt"), image.getAttribute("src")]),
    [["pixel.png", stored[0]!.uri]],
    "Only the strict PNG data URI may render inline",
  )
  assert.equal(article.querySelectorAll("svg, iframe, object, embed, script, a[href]").length, 0)
  assert.ok(!article.innerHTML.includes("example.com") && !article.innerHTML.includes("file://"))
  const download = (name: string) =>
    [...article.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === `Download ${name}`)
  for (const name of ["vector.svg", "page.html"]) {
    download(name)!.click()
    assert.deepEqual(downloads.at(-1), { name, href: "blob:fixture" })
    assert.equal(blobs.at(-1)?.type, "application/octet-stream", `${name} kept an active type`)
  }
  assert.equal(await blobs.at(-1)!.text(), "<script>alert(1)</script>")
  for (const name of ["remote.png", "host.png", "mismatch.png"])
    assert.equal(download(name), undefined, `${name} offered a non-data or mismatched source`)

  // A transient byte-fetch error leaves room text readable and can be retried.
  failAttachmentRead = true
  await room("room-b", "Second")
  await room("room-a", "First")
  await until(() => !!log().textContent?.includes("Attachments could not be loaded"), "Missing attachment retry")
  assert.ok(log().textContent?.includes("Stored files"))
  failAttachmentRead = false
  ;[...log().querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click()
  await until(() => !!log().querySelector('img[alt="pixel.png"]'), "Retried attachment did not load")

  // A late byte response from the old room must never appear in the new room.
  await room("room-b", "Second")
  const lateBytes = Promise.withResolvers<Response>()
  delayedAttachmentRead = lateBytes.promise
  await room("room-a", "First")
  await until(() => delayedAttachmentRead === undefined, "Attachment request did not start")
  await room("room-b", "Second")
  lateBytes.resolve(Response.json(stored))
  await flush()
  await flush()
  assert.equal(log().querySelectorAll("img").length, 0, "Old room attachment leaked into the new room")
  await room("room-a", "First")

  // Select, drop, and paste all land in the draft as removable previews.
  assert.equal(sendButton().disabled, true)
  select([png("picked.png")])
  await until(() => drafts().length === 1, "Selected file did not attach")
  const dropped = drop([new File(["notes"], "notes.txt", { type: "text/plain" })])
  assert.equal(dropped.defaultPrevented, true)
  await until(() => drafts().length === 2, "Dropped file did not attach")
  assert.equal(drop([], "file:///etc/passwd").defaultPrevented, true)
  drop([], "https://example.com/a.png")
  const pasted = paste([png("pasted.png")])
  assert.equal(pasted.defaultPrevented, true)
  await until(() => drafts().length === 3, "Pasted image did not attach")
  assert.equal(paste([], "plain text").defaultPrevented, false)
  nativeClipboard = async () => png("native.png")
  paste([])
  await until(() => drafts().length === 4, "Native clipboard image did not attach")
  assert.deepEqual(drafts(), ["picked.png", "notes.txt", "pasted.png", "native.png"])
  assert.deepEqual(
    [...composer().querySelectorAll("img")].map((image) => image.getAttribute("alt")),
    ["picked.png", "pasted.png", "native.png"],
    "Only raster drafts preview inline",
  )

  // Limits: the sixth file is refused with a visible reason.
  select([png("fifth.png"), png("sixth.png")])
  await until(() => alertText().includes("up to 5"), "Missing attachment limit error")
  assert.equal(drafts().length, 5)
  for (const name of ["notes.txt", "pasted.png", "native.png", "fifth.png"])
    composer().querySelector<HTMLButtonElement>(`button[aria-label="Remove ${name}"]`)!.click()
  assert.deepEqual(drafts(), ["picked.png"])

  // Attachment-only send that fails keeps the draft and retries the exact same message.
  failPost = true
  await until(() => !sendButton().disabled, "Attachment-only draft could not be sent")
  await send()
  await until(() => !!host.textContent?.includes("Network lost"), "Failed send was not reported")
  assert.deepEqual(drafts(), ["picked.png"], "Failed send dropped the draft")
  assert.equal(posts.length, 1)
  assert.equal(posts[0]!.text, "")
  assert.equal(posts[0]!.roomID, "room-a")
  assert.deepEqual(posts[0]!.attachments, [
    { name: "picked.png", mime: "image/png", uri: `data:image/png;base64,${btoa("\x01\x02\x03\x04")}` },
  ])
  await until(() => !sendButton().disabled, "Send stayed busy after failure")
  await send()
  await until(() => posts.length === 2, "Retry was not sent")
  assert.deepEqual(posts[1], posts[0], "Retry changed the message identity")
  assert.deepEqual(drafts(), ["picked.png"], "Second failure dropped the draft")

  // Changing the draft after a failure makes a new message.
  await until(() => !sendButton().disabled, "Send stayed busy after second failure")
  composer().querySelector<HTMLButtonElement>('button[aria-label="Remove picked.png"]')!.click()
  select([png("replacement.png")])
  await until(() => drafts().length === 1, "Replacement did not attach")
  failPost = false
  await send()
  await until(() => posts.length === 3, "Edited draft was not sent")
  assert.notEqual(posts[2]!.id, posts[0]!.id, "Edited draft reused the failed message ID")
  assert.deepEqual(
    posts[2]!.attachments?.map((item) => item.name),
    ["replacement.png"],
  )
  await until(() => drafts().length === 0, "Sent draft was not cleared")
  await until(
    () => !!log().querySelector('img[alt="replacement.png"]'),
    "Sent attachment did not render in the room history",
  )

  // Drafts and in-flight reads stay in the room where they started.
  select([png("room-a.png")])
  await until(() => drafts().length === 1, "Room A draft did not attach")
  const late = Promise.withResolvers<File | null>()
  nativeClipboard = () => late.promise
  paste([])
  await room("room-b", "Second")
  assert.deepEqual(drafts(), [], "Room A draft leaked into room B")
  late.resolve(png("late.png"))
  await flush()
  await flush()
  assert.deepEqual(drafts(), [], "Room A clipboard read landed in room B")
  assert.equal(sendButton().disabled, true)
  await room("room-a", "First")
  assert.deepEqual(drafts(), [], "Abandoned room draft was not cleaned up")

  const roundTrip = Promise.withResolvers<File | null>()
  nativeClipboard = () => roundTrip.promise
  paste([])
  await room("room-b", "Second")
  await room("room-a", "First")
  roundTrip.resolve(png("round-trip.png"))
  await flush()
  await flush()
  assert.deepEqual(drafts(), [], "Abandoned clipboard read returned after a room round trip")
  assert.equal(sendButton().disabled, true)

  // The same room on another server starts clean, including reads still in flight.
  select([png("server-a.png")])
  await until(() => drafts().length === 1, "Server A draft did not attach")
  const crossServer = Promise.withResolvers<File | null>()
  nativeClipboard = () => crossServer.promise
  paste([])
  setSDK(server("http://other.test", "other"))
  await until(() => !!log().textContent?.includes("Stored files"), "Server switch did not load")
  assert.deepEqual(drafts(), [], "Server A draft leaked to server B")
  crossServer.resolve(png("cross-server.png"))
  await flush()
  await flush()
  assert.deepEqual(drafts(), [], "Server A clipboard read landed on server B")
  const before = posts.length
  assert.equal(sendButton().disabled, true)
  sendButton().click()
  await flush()
  assert.equal(posts.length, before, "An empty draft was sent")

  // A failed draft survives navigation so its exact retry stays possible.
  nativeClipboard = async () => null
  select([png("kept.png")])
  await until(() => drafts().length === 1, "Draft did not attach")
  failPost = true
  await send()
  await until(() => posts.length === before + 1, "Failing send was not attempted")
  await until(() => !!host.textContent?.includes("Network lost"), "Failed send was not reported")
  await room("room-b", "Second")
  assert.deepEqual(drafts(), [])
  await room("room-a", "First")
  assert.deepEqual(drafts(), ["kept.png"], "Failed draft was lost on navigation")
  failPost = false
  await send()
  await until(() => posts.length === before + 2, "Retry after navigation was not sent")
  assert.deepEqual(posts.at(-1), posts.at(-2), "Retry after navigation changed the message")
  await until(() => drafts().length === 0, "Retried draft was not cleared")

  // Archived rooms show stored attachments but accept none.
  await room("room-c", "Old")
  await until(() => !!log().querySelector('img[alt="pixel.png"]'), "Archived attachment did not render")
  assert.equal(attach().disabled, true)
  assert.equal(picker().disabled, true)
  select([png("archived.png")])
  assert.equal(drop([png("archived.png")]).defaultPrevented, true)
  assert.equal(paste([png("archived.png")]).defaultPrevented, false)
  nativeClipboard = async () => png("archived-native.png")
  paste([])
  await flush()
  await flush()
  assert.deepEqual(drafts(), [], "Archived room accepted an attachment")
  assert.equal(sendButton().disabled, true)
  console.log("Team attachment checks passed")
} finally {
  dispose()
  interval.mockRestore()
  clearInterval.mockRestore()
  objectURL.mockRestore()
  revokeURL.mockRestore()
  anchorClick.mockRestore()
  host.remove()
}
