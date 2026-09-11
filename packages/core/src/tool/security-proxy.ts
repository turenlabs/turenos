export * as SecurityProxyTool from "./security-proxy"

import { Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { SecurityProxyRuntime } from "../security-proxy-runtime"
import { SessionSchema } from "../session/schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { SecurityProxy } from "@turenlabs/schema/security-proxy"

const CaseInput = Schema.Struct({ url: Schema.optional(Schema.String) })
const CaseOutput = Schema.Struct({ case: SecurityProxy.Case, snapshot: Schema.optional(SecurityProxy.Snapshot) })
const Empty = Schema.Struct({})
const EditInput = Schema.Struct({
  url: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  headers: Schema.optional(SecurityProxy.Headers),
  body: Schema.optional(SecurityProxy.Body),
  status: Schema.optional(Schema.Number),
})
const ReplayInput = Schema.Struct({
  flowID: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  headers: Schema.optional(SecurityProxy.Headers),
  body: Schema.optional(SecurityProxy.Body),
  auth: Schema.optional(Schema.Literals(["captured", "live"])),
})
const DecisionInput = Schema.Struct({
  pauseID: Schema.String,
  generation: Schema.String,
  decision: Schema.Literals(["forward", "drop", "read", "reveal", "extend"]),
  edits: Schema.optional(EditInput),
})

const owner = (location: Location.Interface, sessionID: SessionSchema.ID): SecurityProxy.Owner => ({
  directory: location.directory,
  ...(location.workspaceID ? { workspaceID: location.workspaceID } : {}),
  sessionID,
})

const failure = (error: unknown) =>
  new Tool.Failure({ message: error instanceof Error ? error.message : "Security Browser operation failed" })

function makeProxyTools(location: Location.Interface, runtime: SecurityProxyRuntime.Interface) {
  const execute = (command: SecurityProxy.Command) => runtime.execute(command).pipe(Effect.mapError(failure))
  const caseOwner = (sessionID: SessionSchema.ID) => owner(location, sessionID)
  const caseID = (sessionID: SessionSchema.ID) => `browser_${String(sessionID)}`

  const start = Tool.make({
    input: CaseInput,
    output: CaseOutput,
    description:
      "Start this session's shared isolated Security Browser. Pass an optional URL to open immediately. This creates no AI scan and no model run. Returns the shared browser case and snapshot.",
    execute: (input, context) => {
      const currentOwner = caseOwner(context.sessionID)
      const currentCaseID = caseID(context.sessionID)
      return execute({
        type: "create",
        owner: currentOwner,
        input: {
          id: currentCaseID,
          name:
            (input.url && URL.parse(input.url)?.hostname) || `Session browser ${String(context.sessionID).slice(-8)}`,
        },
      }).pipe(
        Effect.flatMap((created) => {
          if (!created.case) return Effect.fail(new Tool.Failure({ message: "Security Browser case was not created" }))
          return execute({ type: "open", owner: currentOwner, caseID: currentCaseID }).pipe(
            Effect.flatMap((opened) =>
              input.url
                ? execute({ type: "navigate", owner: currentOwner, caseID: currentCaseID, url: input.url }).pipe(
                    Effect.map((nav) => nav.snapshot ?? opened.snapshot),
                  )
                : Effect.succeed(opened.snapshot),
            ),
            Effect.map((snapshot) => ({ case: created.case!, ...(snapshot ? { snapshot } : {}) })),
          )
        }),
      )
    },
  })

  const navigate = Tool.make({
    input: Schema.Struct({ url: Schema.String }),
    output: SecurityProxy.Result,
    description:
      "Navigate this session's shared Security Browser to a URL. Bare hosts use https. The browser must be open (browser_start).",
    execute: (input, context) =>
      execute({
        type: "navigate",
        owner: caseOwner(context.sessionID),
        caseID: caseID(context.sessionID),
        url: input.url,
      }),
  })

  const status = Tool.make({
    input: Empty,
    output: SecurityProxy.Result,
    description: "Read the current shared Security Browser status and paused requests for this session.",
    execute: (_input, context) =>
      execute({ type: "snapshot", owner: caseOwner(context.sessionID), caseID: caseID(context.sessionID) }),
  })

  const intercept = Tool.make({
    input: Schema.Struct({ on: Schema.Boolean, settle: Schema.optional(Schema.Literals(["drop", "forward"])) }),
    output: SecurityProxy.Result,
    description:
      "Turn request/response interception on or off for this session. Turning it off explicitly settles held traffic.",
    execute: (input, context) =>
      execute({
        type: "intercept",
        owner: caseOwner(context.sessionID),
        caseID: caseID(context.sessionID),
        on: input.on,
        settle: input.settle ?? "drop",
      }),
  })

  const decide = Tool.make({
    input: DecisionInput,
    output: SecurityProxy.Result,
    description:
      "Decide one current paused browser request: read, reveal, extend, forward with edits, or drop. Decisions are single-use.",
    execute: (input, context) =>
      execute({
        type: "decide",
        owner: caseOwner(context.sessionID),
        caseID: caseID(context.sessionID),
        ...input,
      }),
  })

  const history = Tool.make({
    input: Empty,
    output: SecurityProxy.Result,
    description: "List the latest bounded masked HTTP flows captured by this session's Security Browser.",
    execute: (_input, context) =>
      execute({ type: "flows", owner: caseOwner(context.sessionID), caseID: caseID(context.sessionID) }),
  })

  const flow = Tool.make({
    input: Schema.Struct({ flowID: Schema.String, reveal: Schema.optional(Schema.Boolean) }),
    output: SecurityProxy.Result,
    description: "Inspect one captured browser flow. It is masked by default; reveal is explicit and owner-scoped.",
    execute: (input, context) =>
      execute({
        type: input.reveal ? "reveal" : "flow",
        owner: caseOwner(context.sessionID),
        caseID: caseID(context.sessionID),
        flowID: input.flowID,
      }),
  })

  const replay = Tool.make({
    input: ReplayInput,
    output: SecurityProxy.Result,
    description:
      "Replay a captured browser request once with optional method, URL, header, body, or captured/live-cookie changes. If flowID is omitted, use the most recent flow.",
    execute: (input, context) => {
      const currentOwner = caseOwner(context.sessionID)
      const currentCaseID = caseID(context.sessionID)
      return execute({ type: "flows", owner: currentOwner, caseID: currentCaseID }).pipe(
        Effect.flatMap((flows) => {
          const selected = input.flowID ?? flows.flows?.[0]?.id
          if (!selected)
            return Effect.fail(new Tool.Failure({ message: "No captured browser flow is available to replay" }))
          const edits =
            input.url || input.method || input.headers || input.body
              ? { url: input.url, method: input.method, headers: input.headers, body: input.body }
              : undefined
          return execute({
            type: "replay",
            owner: currentOwner,
            caseID: currentCaseID,
            flowID: selected,
            replayID: `replay_${crypto.randomUUID()}`,
            auth: input.auth ?? "captured",
            ...(edits ? { edits } : {}),
          })
        }),
      )
    },
  })

  const stop = Tool.make({
    input: Empty,
    output: SecurityProxy.Result,
    description:
      "Close this session's Security Browser and clear its live browser profile without deleting saved case history.",
    execute: (_input, context) =>
      execute({ type: "close", owner: caseOwner(context.sessionID), caseID: caseID(context.sessionID) }),
  })

  return {
    browser_start: start,
    browser_navigate: navigate,
    browser_status: status,
    browser_intercept: intercept,
    browser_decide: decide,
    browser_history: history,
    browser_flow: flow,
    browser_replay: replay,
    browser_stop: stop,
  }
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const location = yield* Location.Service
    const runtime = yield* SecurityProxyRuntime.Service
    yield* tools.register(makeProxyTools(location, runtime))
  }).pipe(Effect.orDie),
)

export const node = makeLocationNode({
  name: "tool/security-proxy",
  layer,
  deps: [ToolRegistry.node, Location.node, SecurityProxyRuntime.node],
})
