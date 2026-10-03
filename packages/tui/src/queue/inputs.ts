import type { SessionsPendingInputsOutput } from "@turenlabs/client"

export type Input = SessionsPendingInputsOutput[number]

/** Messages you sent that the server has admitted but not yet delivered to the agent. */
export function waiting(inputs: readonly Input[] | undefined) {
  return (inputs ?? []).filter((input) => !input.source || input.source === "user")
}
