import type { Plugin } from "./index.js"
import { tool } from "./tool.js"

const CONTEXT_BLOCK_PATTERN = /<!--\s*rlm-context(?:\s+name="([^"]*)")?\s*-->([\s\S]*?)<!--\s*\/rlm-context\s*-->/gi

export type RlmPluginOptions = {
  readonly maxContextChars?: number
  readonly maxContextsPerSession?: number
  readonly maxSearchResults?: number
  readonly maxReadLines?: number
}

type RlmContext = {
  readonly id: string
  readonly sessionID: string
  readonly name: string
  readonly text: string
  readonly lines: readonly string[]
}

export function createRlmPlugin(options: RlmPluginOptions = {}): Plugin {
  const maxContextChars = boundedOption(options.maxContextChars, 8_000_000, 1_000, "maxContextChars")
  const maxContextsPerSession = boundedOption(options.maxContextsPerSession, 32, 1, "maxContextsPerSession")
  const maxSearchResults = boundedOption(options.maxSearchResults, 20, 1, "maxSearchResults")
  const maxReadLines = boundedOption(options.maxReadLines, 200, 1, "maxReadLines")

  return async () => {
    const contexts = new Map<string, RlmContext>()
    const contextIDsBySession = new Map<string, string[]>()
    const latestContextBySession = new Map<string, string>()

    function rememberContext(context: RlmContext) {
      const ids = contextIDsBySession.get(context.sessionID) ?? []
      if (!ids.includes(context.id)) ids.push(context.id)
      while (ids.length > maxContextsPerSession) {
        const evicted = ids.shift()
        if (evicted === undefined) break
        contexts.delete(evicted)
      }
      contexts.set(context.id, context)
      contextIDsBySession.set(context.sessionID, ids)
      latestContextBySession.set(context.sessionID, context.id)
    }

    function removeSession(sessionID: string) {
      for (const id of contextIDsBySession.get(sessionID) ?? []) contexts.delete(id)
      contextIDsBySession.delete(sessionID)
      latestContextBySession.delete(sessionID)
    }

    function requireContext(sessionID: string, contextID?: string) {
      const id = contextID ?? latestContextBySession.get(sessionID)
      if (id === undefined) throw new Error("No RLM context is available in this session")
      const context = contexts.get(id)
      if (!context || context.sessionID !== sessionID) throw new Error(`Unknown RLM context: ${id}`)
      return context
    }

    async function authorize(
      toolName: string,
      contextID: string,
      toolContext: {
        ask(input: {
          permission: string
          patterns: string[]
          always: string[]
          metadata: { [key: string]: unknown }
        }): Promise<void>
      },
    ) {
      await toolContext.ask({
        permission: "rlm.context.read",
        patterns: [contextID],
        always: [],
        metadata: { source: "rlm", tool: toolName },
      })
    }

    function externalizeText(text: string, sessionID: string, messageID: string, partID: string) {
      let blockIndex = 0
      return text.replace(CONTEXT_BLOCK_PATTERN, (match, name: string | undefined, body: string) => {
        const contextText = body.trim()
        if (contextText.length > maxContextChars) {
          throw new Error(
            `RLM context ${messageID}:${partID}:${blockIndex} is ${contextText.length} characters; ` +
              `the limit is ${maxContextChars}`,
          )
        }

        const contextID = encodeURIComponent(`${sessionID}:${messageID}:${partID}:${blockIndex}`)
        const contextName = (name?.trim() || "context").replace(/\s+/g, " ").slice(0, 80)
        rememberContext({
          id: contextID,
          sessionID,
          name: contextName,
          text: contextText,
          lines: contextText.split("\n"),
        })
        blockIndex += 1
        return `\n[RLM external context id=${contextID} name=${JSON.stringify(contextName)} chars=${contextText.length}]\n`
      })
    }

    return {
      tool: {
        rlm_context_search: tool({
          description: "Search an externalized RLM context block and return the highest-scoring matching lines.",
          args: {
            query: tool.schema.string().min(1),
            contextID: tool.schema.string().min(1).optional(),
            limit: tool.schema.number().int().positive().max(50).optional(),
          },
          async execute(args, context) {
            const target = requireContext(context.sessionID, args.contextID)
            await authorize("rlm_context_search", target.id, context)
            const terms = tokenize(args.query)
            const phrase = args.query.trim().toLowerCase()
            const results = target.lines
              .flatMap((line, index) => {
                const normalized = line.toLowerCase()
                const termScore = terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0)
                const score = termScore + (phrase.length > 0 && normalized.includes(phrase) ? terms.length : 0)
                return score === 0 ? [] : [{ line: index + 1, score, text: line }]
              })
              .sort((left, right) => right.score - left.score || left.line - right.line)
              .slice(0, Math.min(args.limit ?? maxSearchResults, maxSearchResults))

            return {
              title: `RLM search: ${results.length} match${results.length === 1 ? "" : "es"}`,
              output: JSON.stringify({ contextID: target.id, name: target.name, query: args.query, results }, null, 2),
            }
          },
        }),
        rlm_context_read: tool({
          description: "Read an exact bounded line range from an externalized RLM context block.",
          args: {
            contextID: tool.schema.string().min(1),
            startLine: tool.schema.number().int().positive(),
            lineCount: tool.schema.number().int().positive().max(500).optional(),
          },
          async execute(args, context) {
            const target = requireContext(context.sessionID, args.contextID)
            await authorize("rlm_context_read", target.id, context)
            const start = Math.min(args.startLine, target.lines.length + 1)
            const count = Math.min(args.lineCount ?? maxReadLines, maxReadLines)
            const lines = target.lines.slice(start - 1, start - 1 + count).map((text, index) => ({
              line: start + index,
              text,
            }))

            return {
              title: `RLM context: lines ${start}-${start + Math.max(lines.length - 1, 0)}`,
              output: JSON.stringify({ contextID: target.id, name: target.name, lines }, null, 2),
            }
          },
        }),
      },
      "experimental.chat.system.transform": async (_input, output) => {
        output.system.push(
          "RLM context blocks marked with <!-- rlm-context --> are externalized. Use rlm_context_search for focused discovery and rlm_context_read for bounded exact inspection before answering.",
        )
      },
      "experimental.chat.messages.transform": async (_input, output) => {
        for (const message of output.messages) {
          if (message.info.role !== "user") continue
          for (const part of message.parts) {
            if (part.type !== "text" || !part.text.includes("rlm-context")) continue
            part.text = externalizeText(part.text, message.info.sessionID, message.info.id, part.id)
          }
        }
      },
      event: async ({ event }) => {
        if (event.type === "session.deleted") removeSession(event.properties.sessionID)
      },
      dispose: async () => {
        contexts.clear()
        contextIDsBySession.clear()
        latestContextBySession.clear()
      },
    }
  }
}

export const RlmPlugin = createRlmPlugin()

export default RlmPlugin

function boundedOption(value: number | undefined, fallback: number, minimum: number, name: string) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum) throw new RangeError(`${name} must be an integer >= ${minimum}`)
  return value
}

function tokenize(value: string) {
  return [...new Set(value.toLowerCase().match(/[a-z0-9_./:-]+/g) ?? [])]
}
