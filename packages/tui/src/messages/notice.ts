import { parseJSON } from "../api"
import { display } from "../messages"

type Notice = "swarm_room" | "subagent_settle"

/** One readable line for a machine-delivered notice, or undefined to show its text as delivered. */
export function noticeLine(source: Notice, text: string) {
  if (text.length > 16000) return undefined
  return source === "swarm_room" ? roomLine(text) : settleLine(text)
}

const text = (value: unknown, limit: number) =>
  typeof value === "string" ? display(value, limit).replace(/\s+/g, " ").trim() : ""

// Matches advisoryText in packages/core/src/team/room.ts; the JSON between the markers is the entry.
function roomLine(body: string) {
  const json = body.match(/<forge-swarm-room-update>\s*([\s\S]*?)\s*<\/forge-swarm-room-update>/)?.[1]
  if (!json) return undefined
  const entry = parseJSON(json)
  if (typeof entry !== "object" || entry === null) return undefined
  const actor = "actor" in entry && typeof entry.actor === "object" && entry.actor ? entry.actor : {}
  const kind = "kind" in entry ? text(entry.kind, 40) : ""
  const type = "type" in actor ? text(actor.type, 40) : ""
  const name = "name" in actor ? text(actor.name, 80) : ""
  const who = type === "human" ? "you" : name || type || "a member"
  const seq = "seq" in entry && typeof entry.seq === "number" ? ` #${entry.seq}` : ""
  const summary = "text" in entry ? text(entry.text, 200) : ""
  return `Room: ${who} posted${seq}${kind ? ` ${kind}` : ""}${summary ? `: ${summary}` : ""}`
}

// Matches settleText in packages/core/src/session/execution/local.ts.
function settleLine(body: string) {
  const head = body.match(/^(\w+): (.+?) \(task \S+, agent ([^)]+)\)$/m)
  if (!head) return undefined
  const start = body.search(/^(?:Result|Error): /m)
  const detail =
    start < 0
      ? ""
      : text(
          body
            .slice(start)
            .replace(/^\w+: /, "")
            .split("\nCollect the full")[0],
          160,
        )
  return `Subagent ${text(head[1], 20)}: ${text(head[2], 200)} (${text(head[3], 60)})${detail ? ` - ${detail}` : ""}`
}
