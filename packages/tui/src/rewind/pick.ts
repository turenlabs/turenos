import { label } from "../state"
import { stamp } from "../menus/stamp"
import { openSection } from "../picker"
import type { Session } from "../server"
import type { Prompt, RewindEnv } from "./flow"
import { real } from "./inspect"

type Row = Prompt & { created: number }

/** Lists the session's user prompts, newest first, from the same bounded 300-message window `/undo` inspects. */
export async function pickPrompt(env: RewindEnv, session: Session, choose: (prompt: Prompt) => void) {
  const revert = session.revert
  await openSection(
    env.renderer,
    env.dialogs,
    env.state,
    { title: "Rewind to an earlier message", keys: "↑↓ choose · Enter review rewind · Esc close" },
    () => prompts(env, session.id),
    (found, picker) => {
      const staged = revert ? found.findIndex((row) => row.id === revert.messageID) : -1
      picker.text.content = found.length
        ? "Choose the prompt to go back to. Nothing is changed until you confirm."
        : "No user prompt in the bounded 300-message window."
      picker.fit()
      picker.set(
        found.map((row, index) => ({
          name: label(row.text, 80),
          description: stamp(row.created),
          run: () => {
            const refusal =
              revert && staged < 0
                ? "Staged boundary is outside the bounded 300-message window."
                : index === staged
                  ? "That prompt is already the staged boundary."
                  : index < staged
                    ? "That prompt is after the staged boundary; use /redo."
                    : undefined
            if (refusal) return env.say(`${refusal} Nothing changed.`, true)
            choose(row)
          },
        })),
      )
    },
  )
}

async function prompts(env: RewindEnv, sessionID: string) {
  const found = new Map<string, Row>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 10; page++) {
    const result = await env.connection.client.messages.list({
      sessionID,
      limit: 30,
      order: cursor ? undefined : "desc",
      cursor,
    })
    result.data.filter(real).forEach((message) => {
      if (!found.has(message.id))
        found.set(message.id, { id: message.id, text: message.text, created: message.time.created })
    })
    const next = result.cursor.next
    if (!next || cursors.has(next)) break
    cursors.add(next)
    cursor = next
  }
  return [...found.values()]
}
