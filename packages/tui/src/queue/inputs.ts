import type { SessionsPendingInputsOutput } from "@turenlabs/client"
import { parseMentions } from "../prompt-files"

export type Input = SessionsPendingInputsOutput[number]

/** Messages you sent that the server has admitted but not yet delivered to the agent. */
export function waiting(inputs: readonly Input[] | undefined) {
  return (inputs ?? []).filter((input) => !input.source || input.source === "user")
}

/**
 * Whether the reply editor can take the message back whole. It rebuilds @file attachments from the
 * text on send, so anything else (images, comments, agents, files the text does not mention) would be lost.
 */
export function editable(input: Input, directory: string) {
  const prompt = input.prompt
  if (prompt.parts?.length || prompt.agents?.length) return false
  const mentioned = new Set(parseMentions(prompt.text, directory).map((file) => file.uri))
  return (prompt.files ?? []).every((file) => mentioned.has(file.uri))
}
