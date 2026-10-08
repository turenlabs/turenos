import type { Team } from "@turenlabs/schema/team"
import type { FileContent, FilePart, Message, SessionMessage } from "@turenlabs/sdk/v2"
import { DataProvider } from "@turenlabs/session-ui/context/data"
import { Markdown } from "@turenlabs/session-ui/markdown"
import { Part } from "@turenlabs/session-ui/message-part"
import { createPathHelpers, decodeFilePath, stripQueryAndHash } from "@/context/file/path"
import { dataUrlFromMediaValue, mediaKindFromPath } from "@turenlabs/session-ui/pierre/media"
import { Dialog } from "@turenlabs/ui/dialog"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { useFileComponent } from "@turenlabs/ui/context/file"
import { Dynamic } from "solid-js/web"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { sessionHref } from "@/utils/session-route"
import { presentTool } from "@/pages/session/goal/session-v2-presentation"
import { usePlatform } from "@/context/platform"
import { authTokenFromCredentials } from "@/utils/server"

export type TeamMessageContentProps = { message: Team.Message; directory?: string }
type SourceMessage = { info: Message; parts: PartType[] }
type PartType = import("@turenlabs/sdk/v2").Part
type NativeSession = { id: string; location: { directory: string } }

export function presentTeamAssistant(sessionID: string, directory: string, source: SessionMessage): SourceMessage | undefined {
  if (source.type !== "assistant") return
  return {
    info: {
      id: source.id, sessionID, role: "assistant", time: source.time,
      // Selected tool cards do not use transcript parentage. Do not invent a user message.
      parentID: "", modelID: source.model.id, providerID: source.model.providerID, variant: source.model.variant,
      mode: source.agent, agent: source.agent, path: { cwd: directory, root: directory },
      cost: source.cost ?? 0,
      tokens: source.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: source.finish,
    },
    parts: source.content.flatMap((content) => content.type === "tool" ? [presentTool(sessionID, source.id, content)] : []),
  }
}

export function teamAttachmentPath(source: string) {
  if (!source || source.startsWith("#") || source.startsWith("//")) return
  if (/^[a-z]:[\\/]/i.test(source)) return decodeFilePath(stripQueryAndHash(source))
  if (!URL.canParse(source)) return decodeFilePath(stripQueryAndHash(source))
  const url = new URL(source)
  if (url.protocol !== "file:" || url.hostname) return
  return decodeFilePath(url.pathname).replace(/^\/([a-z]:\/)/i, "$1")
}

export function teamPdfBytes(content: FileContent) {
  if (content.type !== "binary" || content.encoding !== "base64" || content.mimeType !== "application/pdf") return
  if (!content.content || content.content.length > 22_369_624 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content.content)) return
  try {
    const decoded = atob(content.content)
    if (decoded.length > 16 * 1024 * 1024 || !/^%PDF-[12]\.\d/.test(decoded) || !decoded.slice(-1024).includes("%%EOF")) return
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0))
  } catch {
    return
  }
}

export function selectTeamRichParts(sessionID: string, sourceIDs: readonly string[], messages: readonly SourceMessage[]) {
  const sources = new Set(sourceIDs)
  const seen = new Set<string>()
  return messages.flatMap((message) => {
    if (message.info.sessionID !== sessionID || message.info.role !== "assistant" || !sources.has(message.info.id))
      return []
    return message.parts.flatMap((part) => {
      if (part.sessionID !== sessionID || part.messageID !== message.info.id) return []
      const parts: PartType[] = part.type === "file"
        ? [part]
        : part.type === "tool" && part.state.status === "completed"
          ? [
              ...((part.tool === "safehtml" || part.tool === "visualize") ? [part] : []),
              ...(part.state.attachments ?? []),
            ]
          : []
      return parts.flatMap((item) => {
        if (item.sessionID !== sessionID || item.messageID !== message.info.id || seen.has(item.id)) return []
        seen.add(item.id)
        return [{ message: message.info, part: item }]
      })
    })
  })
}

export function TeamMessageContent(props: TeamMessageContentProps) {
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const dialog = useDialog()
  const fileComponent = useFileComponent()
  const [retry, setRetry] = createSignal(0)
  const [failure, setFailure] = createSignal<{ client: ReturnType<typeof serverSDK>["client"]; sessionID: string; sources: string }>()
  const [loaded, setLoaded] = createSignal<{
    client: ReturnType<typeof serverSDK>["client"]
    sessionID: string
    sources: string
    session: NativeSession
    messages: SourceMessage[]
  }>()
  const sourceKey = createMemo(() => JSON.stringify(props.message.sourceMessageIDs ?? []))
  const failed = () => {
    const value = failure()
    return value?.client === serverSDK().client && value.sessionID === props.message.sessionID && value.sources === sourceKey()
  }
  const href = () => props.message.sessionID ? sessionHref(ServerConnection.key(serverSDK().server), props.message.sessionID) : undefined
  const current = createMemo(() => {
    const value = loaded()
    if (value?.client !== serverSDK().client || value.sessionID !== props.message.sessionID || value.sources !== sourceKey())
      return
    return value
  })
  createEffect(() => {
    const client = serverSDK().client
    const sessionID = props.message.sessionID
    const sources = sourceKey()
    const ids = [...new Set(props.message.sourceMessageIDs ?? [])]
    retry()
    setLoaded(undefined)
    setFailure(undefined)
    if (!sessionID) return
    let active = true
    onCleanup(() => { active = false })
    void client.v2.session.get({ sessionID }).then(async (response) => {
      const session = response.data?.data
      if (!active) return
      if (!session || session.id !== sessionID || !session.location.directory) throw new Error("Session location is unavailable")
      const messages = await Promise.all(ids.map((messageID) =>
        client.v2.session.message({ sessionID, messageID }).then((result) => {
          const source = result.data?.data
          if (!source || source.id !== messageID) return
          return presentTeamAssistant(sessionID, session.location.directory, source)
        }).catch(() => undefined),
      ))
      if (!active) return
      if (messages.some((message, index) => !message || message.info.id !== ids[index] || message.info.sessionID !== sessionID || message.info.role !== "assistant"))
        setFailure({ client, sessionID, sources })
      setLoaded({ client, sessionID, sources, session, messages: messages.filter((message): message is SourceMessage => !!message) })
    }).catch(() => { if (active) setFailure({ client, sessionID, sources }) })
  })
  const rich = createMemo(() => {
    const value = current()
    return value ? selectTeamRichParts(value.sessionID, props.message.sourceMessageIDs ?? [], value.messages) : []
  })
  const readFile = async (path: string): Promise<FileContent | undefined> => {
    const owner = current()
    if (!owner) return
    const server = serverSDK().server.http
    const relative = createPathHelpers(() => owner.session.location.directory).normalize(path)
    const url = new URL(`/api/fs/read/${relative.split("/").map(encodeURIComponent).join("/")}`, server.url)
    url.searchParams.set("location[directory]", owner.session.location.directory)
    const response = await (platform.fetch ?? fetch)(url, {
      headers: server.password ? { Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}` } : undefined,
    })
    if (!response.ok || Number(response.headers.get("content-length")) > 16 * 1024 * 1024) throw new Error("File preview is unavailable")
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (current() !== owner) return
    if (!mimeType || bytes.length > 16 * 1024 * 1024) throw new Error("File preview is unavailable")
    if (mimeType.startsWith("text/") || mimeType === "application/json")
      return { type: "text", content: new TextDecoder().decode(bytes), mimeType }
    const content = btoa(Array.from({ length: Math.ceil(bytes.length / 32768) }, (_, index) =>
      String.fromCharCode(...bytes.subarray(index * 32768, (index + 1) * 32768)),
    ).join(""))
    return { type: "binary", encoding: "base64", content, mimeType }
  }
  const resolveImage = async (path: string) => {
    const kind = mediaKindFromPath(path)
    if (kind !== "image" && kind !== "svg") return
    return dataUrlFromMediaValue(await readFile(path), kind)
  }
  const openFile = async (path: string) => {
    const owner = current()
    if (!owner) {
      dialog.show(() => <Dialog title="File preview"><p>Open the Session to inspect this file.</p><Show when={href()}>{(url) => <a href={url()}>Open Session</a>}</Show></Dialog>)
      return
    }
    const content = await readFile(path).catch(() => undefined)
    if (current() !== owner) return
    dialog.show(() => (
      <Dialog title={path} size="large">
        <Show when={current() === owner && content} fallback={<p role="status">File preview is unavailable.</p>}>
          {(value) => value().mimeType === "application/pdf" ? (
            <TeamPdfPreview content={value()} />
          ) : (
            <Show when={value().type !== "binary" || mediaKindFromPath(path)} fallback={<p role="status">This binary file has no preview. <Show when={href()}>{(url) => <a href={url()}>Open Session</a>}</Show></p>}>
              <Dynamic
                component={fileComponent}
                mode="text"
                file={{ name: path, contents: value().type === "text" ? value().content : "", cacheKey: path }}
                media={{ path, current: value(), readFile }}
              />
            </Show>
          )}
        </Show>
      </Dialog>
    ))
  }
  const data = createMemo(() => ({
    session: [],
    session_status: {},
    session_diff: {},
    message: current() ? { [current()!.sessionID]: current()!.messages.map((message) => message.info) } : {},
    part: Object.fromEntries((current()?.messages ?? []).map((message) => [message.info.id, message.parts])),
  }))
  return (
    <div data-component="team-message-content" class="min-w-0">
      <Markdown text={props.message.text} resolveImage={resolveImage} onFileLink={(path) => { void openFile(path) }} />
      <Show when={failed()}>
        <p role="status">Some rich output could not be loaded. <button type="button" class="underline" onClick={() => setRetry((value) => value + 1)}>Retry</button> <Show when={href()}>{(url) => <a href={url()}>Open Session</a>}</Show></p>
      </Show>
      <Show when={current()}>
        {(value) => (
          <DataProvider data={data()} directory={value().session.location.directory}>
            <For each={rich()}>
              {(item) => item.part.type === "file" ? (
                <TeamFileAttachment part={item.part} onOpen={openFile} />
              ) : (
                <Part part={item.part} message={item.message} defaultOpen useV2Actions />
              )}
            </For>
          </DataProvider>
        )}
      </Show>
    </div>
  )
}

function TeamFileAttachment(props: { part: FilePart; onOpen: (path: string) => Promise<void> }) {
  const path = () => teamAttachmentPath(props.part.url)
  return (
    <Show when={path()} fallback={<p class="my-2 text-[12px]">Attachment: {props.part.filename ?? props.part.mime}. File preview is unavailable.</p>}>
      {(value) => (
        <button type="button" class="my-2 block text-[12px] underline" onClick={() => { void props.onOpen(value()) }}>
          Open file: {props.part.filename ?? value()}
        </button>
      )}
    </Show>
  )
}

function TeamPdfPreview(props: { content: FileContent }) {
  const bytes = createMemo(() => teamPdfBytes(props.content))
  const [url, setUrl] = createSignal<string>()
  createEffect(() => {
    const value = bytes()
    setUrl(undefined)
    if (!value) return
    const next = URL.createObjectURL(new Blob([value], { type: "application/pdf" }))
    setUrl(next)
    onCleanup(() => URL.revokeObjectURL(next))
  })
  return (
    <Show when={url()} fallback={<p role="status">PDF preview is unavailable. The file must be a PDF under 16 MiB.</p>}>
      {(value) => (
        <>
          <a href={value()} target="_blank" rel="noopener noreferrer" class="block py-2 underline">Open PDF in the browser viewer</a>
          <iframe title="PDF preview" src={value()} sandbox="" referrerpolicy="no-referrer" style={{ width: "100%", height: "65vh", border: "0" }} />
        </>
      )}
    </Show>
  )
}
