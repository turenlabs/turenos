import { getFilename } from "@turenlabs/core/util/path"
import {
  type AgentPartInput,
  type FilePartInput,
  type Part,
  type PromptInput,
  type TextPartInput,
} from "@turenlabs/sdk/v2/client"
import type { FileSelection } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import type { AgentPart, FileAttachmentPart, ImageAttachmentPart, Prompt, SurfacePart } from "@/context/prompt"
import { Identifier } from "@/utils/id"
import { createCommentMetadata, formatCommentNote, readCommentMetadata } from "@/utils/comment-note"

type PromptRequestPart = (TextPartInput | FilePartInput | AgentPartInput) & { id: string }

const AUTOMATIONS_GUIDANCE = `<automations-surface>
The user referenced @automations, this app's Automations surface.
An Automation is a durable scheduled workflow: a repeating interval trigger (at least 60 seconds) plus 1 to 12 ordered agent or skill steps that run in their own session and deliver back to the user.
Read the current Automations with the automation_list tool, add one with automation_create, and change, pause, resume, or delete one with automation_update.
</automations-surface>`

const HANDOFF_GUIDANCE = `<handoff-surface>
The user referenced @handoff. They want the current work continued in a new top-level TurenOS session, not a subagent child.
Before calling handoff_session, write a self-contained continuation brief covering the objective, progress, decisions, relevant files, checks run, blockers, and exact next steps. Call handoff_session once with a concise title and that complete brief as the prompt.
The tool uses the current project, agent, and resolved model unless the user explicitly names another project directory. When a destination project is specified, pass its absolute path as the optional project argument; otherwise omit project to preserve the current-project behavior. It creates a root session with no parent task, admits the brief durably, starts it immediately, and returns its session ID. The new session will appear in the Agents left navigation. Do not use spawn_agent for this request.
</handoff-surface>`

type ContextFile = {
  key: string
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

type BuildRequestPartsInput = {
  prompt: Prompt
  context: ContextFile[]
  images: ImageAttachmentPart[]
  text: string
  messageID: string
  sessionID: string
  sessionDirectory: string
}

const absolute = (directory: string, path: string) => {
  if (path.startsWith("/")) return path
  if (/^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)) return path
  if (path.startsWith("\\\\") || path.startsWith("//")) return path
  return `${directory.replace(/[\\/]+$/, "")}/${path}`
}

const fileQuery = (selection: FileSelection | undefined) =>
  selection ? `?start=${selection.startLine}&end=${selection.endLine}` : ""

const mention = /(^|[\s([{"'])@(\S+)/g

const parseCommentMentions = (comment: string) => {
  return Array.from(comment.matchAll(mention)).flatMap((match) => {
    const path = (match[2] ?? "").replace(/[.,!?;:)}\]"']+$/, "")
    if (!path) return []
    return [path]
  })
}

const isFileAttachment = (part: Prompt[number]): part is FileAttachmentPart => part.type === "file"
const isAgentAttachment = (part: Prompt[number]): part is AgentPart => part.type === "agent"
const isSurfaceAttachment = (part: Prompt[number]): part is SurfacePart => part.type === "surface"
const containsHandoffMention = (text: string) => /(^|[\s([{"'])@handoff(?:$|[\s.,!?;:)}\]"'])/.test(text)
const toOptimisticPart = (part: PromptRequestPart, sessionID: string, messageID: string): Part => {
  if (part.type === "text") {
    return {
      id: part.id,
      type: "text",
      text: part.text,
      synthetic: part.synthetic,
      ignored: part.ignored,
      time: part.time,
      metadata: part.metadata,
      sessionID,
      messageID,
    }
  }
  if (part.type === "file") {
    return {
      id: part.id,
      type: "file",
      mime: part.mime,
      filename: part.filename,
      url: part.url,
      source: part.source,
      sessionID,
      messageID,
    }
  }
  return {
    id: part.id,
    type: "agent",
    name: part.name,
    source: part.source,
    sessionID,
    messageID,
  }
}

export function buildRequestParts(input: BuildRequestPartsInput) {
  const requestParts: PromptRequestPart[] = [
    {
      id: Identifier.ascending("part"),
      type: "text",
      text: input.text,
    },
  ]

  const files = input.prompt.filter(isFileAttachment).map((attachment) => {
    const path = absolute(input.sessionDirectory, attachment.path)
    const source = attachment.source
      ? {
          ...attachment.source,
          text: {
            value: attachment.content,
            start: attachment.start,
            end: attachment.end,
          },
        }
      : {
          type: "file" as const,
          text: {
            value: attachment.content,
            start: attachment.start,
            end: attachment.end,
          },
          path,
        }
    return {
      id: Identifier.ascending("part"),
      type: "file",
      mime: attachment.mime ?? "text/plain",
      url: attachment.url ?? `file://${encodeFilePath(path)}${fileQuery(attachment.selection)}`,
      filename: attachment.filename ?? getFilename(attachment.path),
      source,
    } satisfies PromptRequestPart
  })

  const agents = input.prompt.filter(isAgentAttachment).map((attachment) => {
    return {
      id: Identifier.ascending("part"),
      type: "agent",
      name: attachment.name,
      source: {
        value: attachment.content,
        start: attachment.start,
        end: attachment.end,
      },
    } satisfies PromptRequestPart
  })

  const surfaceIDs = new Set(input.prompt.filter(isSurfaceAttachment).map((part) => part.surface))
  if (containsHandoffMention(input.text)) surfaceIDs.add("handoff")
  const surfaces = [...surfaceIDs].flatMap((surface) => {
    if (surface === "swarm") return []
    return [
      {
        id: Identifier.ascending("part"),
        type: "text" as const,
        text: surface === "automations" ? AUTOMATIONS_GUIDANCE : HANDOFF_GUIDANCE,
        synthetic: true,
      },
    ]
  }) satisfies PromptRequestPart[]

  const used = new Set(files.map((part) => part.url))
  const context = input.context.flatMap((item) => {
    const path = absolute(input.sessionDirectory, item.path)
    const url = `file://${encodeFilePath(path)}${fileQuery(item.selection)}`
    const comment = item.comment?.trim()
    if (!comment && used.has(url)) return []
    used.add(url)

    const filePart = {
      id: Identifier.ascending("part"),
      type: "file",
      mime: "text/plain",
      url,
      filename: getFilename(item.path),
    } satisfies PromptRequestPart

    if (!comment) return [filePart]

    const mentions = parseCommentMentions(comment).flatMap((path) => {
      const url = `file://${encodeFilePath(absolute(input.sessionDirectory, path))}`
      if (used.has(url)) return []
      used.add(url)
      return [
        {
          id: Identifier.ascending("part"),
          type: "file",
          mime: "text/plain",
          url,
          filename: getFilename(path),
        } satisfies PromptRequestPart,
      ]
    })

    return [
      {
        id: Identifier.ascending("part"),
        type: "text",
        text: formatCommentNote({ path: item.path, selection: item.selection, comment }),
        synthetic: true,
        metadata: createCommentMetadata({
          path: item.path,
          selection: item.selection,
          comment,
          preview: item.preview,
          origin: item.commentOrigin,
        }),
      } satisfies PromptRequestPart,
      filePart,
      ...mentions,
    ]
  })

  const images = input.images.map((attachment) => {
    return {
      id: Identifier.ascending("part"),
      type: "file",
      mime: attachment.mime,
      url: attachment.sourcePath ? `file://${encodeFilePath(attachment.sourcePath)}` : attachment.dataUrl,
      filename: attachment.sourcePath ?? attachment.filename,
    } satisfies PromptRequestPart
  })

  requestParts.push(...files, ...context, ...agents, ...surfaces, ...images)

  return {
    requestParts,
    v2Prompt: toV2Prompt(requestParts),
    optimisticParts: requestParts.map((part) => toOptimisticPart(part, input.sessionID, input.messageID)),
  }
}

export function toV2Prompt(parts: PromptRequestPart[]): PromptInput {
  const text: string[] = []
  const textParts: NonNullable<PromptInput["parts"]> = []
  const files: NonNullable<PromptInput["files"]> = []
  const agents: NonNullable<PromptInput["agents"]> = []
  for (const part of parts) {
    if (part.type === "text") {
      if (!part.ignored && part.text) text.push(part.text)
      const comment = readCommentMetadata(part.metadata)
      textParts.push({
        id: part.id,
        text: part.text,
        synthetic: part.synthetic,
        ignored: part.ignored,
        metadata: comment ? createCommentMetadata(comment) : undefined,
      })
      continue
    }
    if (part.type === "file") {
      files.push({
        uri: part.url,
        name: part.filename,
        source: part.source?.text
          ? {
              text: part.source.text.value,
              start: part.source.text.start,
              end: part.source.text.end,
            }
          : undefined,
      })
      continue
    }
    agents.push({
      name: part.name,
      source: part.source
        ? {
            text: part.source.value,
            start: part.source.start,
            end: part.source.end,
          }
        : undefined,
    })
  }
  return {
    text: text.join("\n\n"),
    parts: textParts,
    files: files.length ? files : undefined,
    agents: agents.length ? agents : undefined,
  }
}
