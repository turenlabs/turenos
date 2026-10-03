import type { SessionsCreateOutput } from "@turenlabs/client"
import { promptPayload } from "../prompt-files"
import { invalid, modelRef, name } from "../response-validation"
import type { Context } from "./context"
import { resolveCommand } from "./queries"
import { inputDirectory } from "./transport"

type LaunchInput = { directory: string; agent?: string; model?: string; variant?: string; prompt: string }

type LaunchState = {
  sessionID: string
  messageID: string
  admitted?: SessionsCreateOutput
  draft?: LaunchInput
  routing?: Promise<{ command: string; arguments: string } | undefined>
}

// Retain the same identifiers across ambiguous network failures so retrying
// admission cannot create another agent or deliver its initial prompt twice.
export function launch(ctx: Context) {
  const state: LaunchState = {
    sessionID: `ses_${crypto.randomUUID().replaceAll("-", "")}`,
    messageID: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
  }
  const send = (input: LaunchInput) => admit(ctx, state, input)
  return Object.assign(send, {
    sessionID: state.sessionID,
    input: () => (state.draft ? { ...state.draft } : undefined),
  })
}

async function admit(ctx: Context, state: LaunchState, given: LaunchInput) {
  const input = { ...given }
  inputDirectory(input.directory)
  if (input.agent !== undefined) {
    try {
      name(input.agent)
    } catch {
      throw new Error("Choose a valid agent from this directory's list, or use Server default.")
    }
  }
  if (!input.prompt.trim()) throw new Error("Enter a task for the agent.")
  if (input.prompt.length > 32000) throw new Error("Keep the prompt below 32,000 characters.")
  if (state.draft && JSON.stringify(state.draft) !== JSON.stringify(input)) {
    throw new Error(
      `Retry with the original fields. Inspect session ${state.sessionID} before starting another launch.`,
    )
  }
  const model = launchModel(input)
  state.draft = { ...input }
  // Freeze even an unknown command's prompt route before the first POST.
  // Inventory failures are safe to retry because no admission has occurred.
  const command = await (state.routing ??= resolveCommand(ctx, input.prompt, input.directory).catch(
    (error: unknown) => {
      state.routing = undefined
      throw error
    },
  ))
  state.admitted ??= await ctx.client.sessions.create({
    id: state.sessionID,
    location: { directory: input.directory },
    agent: input.agent,
    model,
  })
  if (state.admitted.id !== state.sessionID) invalid("launch session identity")
  if (command) {
    await ctx.client.sessions.command({
      sessionID: state.admitted.id,
      id: state.messageID,
      ...command,
      agent: input.agent,
      model,
      resume: true,
    })
  } else {
    await ctx.client.sessions.prompt({
      sessionID: state.admitted.id,
      id: state.messageID,
      prompt: promptPayload(input.prompt, input.directory),
    })
  }
  return state.admitted
}

function launchModel(input: LaunchInput) {
  const slash = input.model?.indexOf("/") ?? -1
  if (input.variant !== undefined && !input.model)
    throw new Error("Choose an explicit model before selecting its variant.")
  if (input.model && (slash < 1 || slash === input.model.length - 1))
    throw new Error("Use provider/model for the model, or leave it empty.")
  const model = input.model
    ? {
        providerID: input.model.slice(0, slash),
        id: input.model.slice(slash + 1),
        ...(input.variant !== undefined ? { variant: input.variant } : {}),
      }
    : undefined
  if (model) {
    try {
      modelRef(model)
    } catch {
      throw new Error("Use provider/model with names of 1–512 characters and no control characters, or leave it empty.")
    }
  }
  return model
}
