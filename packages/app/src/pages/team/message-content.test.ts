import { describe, expect, test } from "bun:test"
import type { AssistantMessage, FileContent, Part, SessionMessage } from "@turenlabs/sdk/v2"
import { presentTeamAssistant, selectTeamRichParts, teamAttachmentPath, teamPdfBytes } from "./message-content"

const message: AssistantMessage = {
  id: "assistant", sessionID: "session", role: "assistant", parentID: "prompt",
  time: { created: 1, completed: 2 }, modelID: "model", providerID: "provider", mode: "agent", agent: "agent",
  path: { cwd: "/actual", root: "/actual" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}
const file: Part = { id: "file", sessionID: "session", messageID: "assistant", type: "file", mime: "application/pdf", url: "file:///actual/report.pdf" }
const tool = (name: string, id = name): Part => ({
  id, sessionID: "session", messageID: "assistant", type: "tool", tool: name, callID: id,
  state: { status: "completed", input: {}, output: "not parsed as HTML", title: name, metadata: { retained: true }, time: { start: 1, end: 2 } },
})

describe("Team rich part selection", () => {
  test("keeps actual HTML, visualization and file parts without text or tool noise", () => {
    const html = tool("safehtml")
    const chart = tool("visualize")
    const parts: Part[] = [html, chart, file, tool("bash"), { id: "text", sessionID: "session", messageID: "assistant", type: "text", text: "Already in room text" }]
    const selected = selectTeamRichParts("session", [message.id], [{ info: message, parts }])
    expect(selected.map((item) => item.part.id)).toEqual(["safehtml", "visualize", "file"])
    expect(selected[0]!.part).toBe(html)
    expect(selected[0]!.message).toBe(message)
  })
  test("legacy messages and unrelated sources have no rich parts", () => {
    expect(selectTeamRichParts("session", [], [{ info: message, parts: [file] }])).toEqual([])
    expect(selectTeamRichParts("session", ["other"], [{ info: message, parts: [file] }])).toEqual([])
    expect(selectTeamRichParts("other-session", [message.id], [{ info: message, parts: [file] }])).toEqual([])
  })
  test("rejects cross-message parts and duplicates", () => {
    const wrong = { ...file, id: "wrong", messageID: "unrelated" }
    const selected = selectTeamRichParts("session", [message.id], [{ info: message, parts: [wrong, file, file] }])
    expect(selected.map((item) => item.part.id)).toEqual(["file"])
  })
  test("keeps attachments from ordinary completed tools without their tool cards", () => {
    const source = tool("write")
    if (source.type !== "tool" || source.state.status !== "completed") throw new Error("Expected completed tool")
    source.state.attachments = [file]
    expect(selectTeamRichParts("session", [message.id], [{ info: message, parts: [source] }]).map((item) => item.part.id)).toEqual(["file"])
  })
})

describe("Team file preview validation", () => {
  test("uses local file paths and rejects external URLs", () => {
    expect(teamAttachmentPath("file:///actual/report%20final.pdf")).toBe("/actual/report final.pdf")
    expect(teamAttachmentPath("report.pdf#page=1")).toBe("report.pdf")
    expect(teamAttachmentPath("C:\\reports\\report.pdf")).toBe("C:\\reports\\report.pdf")
    expect(teamAttachmentPath("file://remote/report.pdf")).toBeUndefined()
    expect(teamAttachmentPath("https://example.test/report.pdf")).toBeUndefined()
    expect(teamAttachmentPath("data:text/html;base64,AAAA")).toBeUndefined()
  })
  test("accepts bounded PDF bytes only with the exact MIME, header, and end marker", () => {
    const content: FileContent = { type: "binary", encoding: "base64", mimeType: "application/pdf", content: btoa("%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n") }
    expect(new TextDecoder().decode(teamPdfBytes(content))).toContain("%PDF-1.7")
    expect(teamPdfBytes({ ...content, mimeType: "text/html" })).toBeUndefined()
    expect(teamPdfBytes({ ...content, content: btoa("<html>not a PDF</html>") })).toBeUndefined()
    expect(teamPdfBytes({ ...content, content: "invalid!" })).toBeUndefined()
    expect(teamPdfBytes({ ...content, content: "A".repeat(22_369_625) })).toBeUndefined()
  })
})

test("projects a standalone native assistant through the existing tool adapter", () => {
  const spec = { version: 1, title: "Result", html: "<p>Measured result</p>" }
  const source: SessionMessage = {
    id: "native-assistant", type: "assistant", agent: "build", model: { providerID: "provider", id: "model" },
    time: { created: 1, completed: 2 },
    content: [
      { id: "native-text", type: "text", text: "Do not duplicate room text" },
      { id: "native-tool", type: "tool", name: "safehtml", time: { created: 1, completed: 2 },
        state: { status: "completed", input: spec, structured: spec, content: [{ type: "text", text: "Displayed" }],
          attachments: [{ uri: "file:///actual/report.pdf", mime: "application/pdf", name: "report.pdf" }] } },
    ],
  }
  const projected = presentTeamAssistant("session", "/actual", source)
  expect(projected?.info.id).toBe(source.id)
  expect(projected?.parts.map((part) => part.id)).toEqual(["native-tool"])
  const selected = selectTeamRichParts("session", [source.id], projected ? [projected] : [])
  expect(selected.map((item) => item.part.type)).toEqual(["tool", "file"])
  const part = selected[0]?.part
  if (part?.type !== "tool" || part.state.status !== "completed") throw new Error("Expected completed native tool")
  expect(part.state.metadata.structured).toEqual(spec)
})
