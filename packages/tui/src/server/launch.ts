import type { SessionsCreateOutput } from "@turenlabs/client"
import { pathKey } from "@turenlabs/client/path-key"
import { promptPayload } from "../prompt-files"
import { invalid, modelRef, name } from "../response-validation"
import type { Context } from "./context"
import { resolveCommand } from "./queries"
import { refused } from "./errors"
import { inputDirectory } from "./transport"

type LaunchInput = { directory: string; agent?: string; model?: string; variant?: string; prompt: string }

type LaunchState = {
  sessionID: string
  messageID: string
  admitted?: SessionsCreateOutput
  /** The fields the server's session was created with; only the prompt may change afterwards. */
  created?: LaunchInput
  draft?: LaunchInput
  routing?: Promise<{ command: string; arguments: string } | undefined>
  prompt?: ReturnType<typeof promptPayload>
}

// Retain the same identifiers across ambiguous network failures so retrying
// admission cannot create another agent or deliver its initial prompt twice.
// A script that retries a launch in a new process passes the IDs it printed the first time.
export function launch(ctx: Context, ids: { sessionID?: string; messageID?: string } = {}) {
  const state: LaunchState = {
    sessionID: ids.sessionID ?? `ses_${crypto.randomUUID().replaceAll("-", "")}`,
    messageID: ids.messageID ?? `msg_${crypto.randomUUID().replaceAll("-", "")}`,
  }
  const send = (input: LaunchInput) => admit(ctx, state, input)
  return Object.assign(send, {
    sessionID: state.sessionID,
    messageID: state.messageID,
    input: () => (state.draft ? { ...state.draft } : undefined),
  })
}

/** The checks every launch runs before anything is sent; returns the model reference the server takes. */
export function checkLaunch(input: LaunchInput) {
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
  return launchModel(input)
}

async function admit(ctx: Context, state: LaunchState, given: LaunchInput) {
  const input = { ...given }
  const model = checkLaunch(input)
  if (state.draft && JSON.stringify(state.draft) !== JSON.stringify(input)) {
    throw new Error(
      `Retry with the original fields. Inspect session ${state.sessionID} before starting another launch.`,
    )
  }
  if (state.created && !sameFields(state.created, input))
    throw new Error(
      `Session ${state.sessionID} already exists with other directory, agent or model fields. Restore them or inspect it.`,
    )
  // An unlocked draft routes afresh: its prompt or the command inventory may have changed.
  if (!state.draft) state.routing = undefined
  // Inventory failures are safe to retry because nothing has been sent, so the fields stay editable.
  const command = await (state.routing ??= resolveCommand(ctx, input.prompt, input.directory).catch(
    (error: unknown) => {
      state.routing = undefined
      throw error
    },
  ))
  // Freeze the fields and the prompt route only once bytes may go out.
  if (!state.draft && !command) state.prompt = promptPayload(input.prompt, input.directory, ctx)
  state.draft = { ...input }
  return write(ctx, state, input, model, command).catch((error: unknown) => {
    // A definite 4xx admitted nothing: keep the IDs and the text, release the fields.
    if (refused(error)) {
      state.draft = undefined
      state.routing = undefined
      state.prompt = undefined
    }
    throw error
  })
}

/** Nothing was sent: the fields are released as for a definite refusal, and the message names no server text. */
function foreignSession(state: LaunchState) {
  state.draft = undefined
  state.routing = undefined
  state.prompt = undefined
  return new Error(
    `Session ${state.sessionID} already exists with another directory or agent than requested. Nothing was sent.`,
  )
}

async function write(
  ctx: Context,
  state: LaunchState,
  input: LaunchInput,
  model: ReturnType<typeof launchModel>,
  command: Awaited<NonNullable<LaunchState["routing"]>>,
) {
  state.admitted ??= await ctx.client.sessions.create({
    id: state.sessionID,
    location: { directory: input.directory },
    agent: input.agent,
    model,
  })
  if (state.admitted.id !== state.sessionID) invalid("launch session identity")
  // Core creates idempotently per ID, so an existing session comes back unchanged: refuse it before the prompt goes in.
  const directory = pathKey(state.admitted.location.directory) !== pathKey(input.directory)
  if (directory || (input.agent && state.admitted.agent !== input.agent)) throw foreignSession(state)
  state.created ??= { ...input }
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
      prompt: state.prompt!,
    })
  }
  return state.admitted
}

function sameFields(created: LaunchInput, input: LaunchInput) {
  return (
    created.directory === input.directory &&
    created.agent === input.agent &&
    created.model === input.model &&
    created.variant === input.variant
  )
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
