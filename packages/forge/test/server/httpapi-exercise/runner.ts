import { Flag } from "@turenlabs/core/flag/flag"
import { SessionV1 } from "@turenlabs/core/v1/session"
import { Agent } from "@turenlabs/schema/agent"
import { Prompt } from "@turenlabs/schema/prompt"
import { AbsolutePath } from "@turenlabs/schema/schema"
import { SessionEvent } from "@turenlabs/schema/session-event"
import { SessionMessage } from "@turenlabs/schema/session-message"
import { Cause, DateTime, Duration, Effect, Layer, Scope } from "effect"
import { MessageID, PartID } from "../../../src/session/schema"
import { call, callAuthProbe, disposeApps } from "./backend"
import { original } from "./environment"
import { runtime, type Runtime } from "./runtime"
import type { ActiveScenario, Options, ProjectOptions, Result, Scenario, ScenarioContext, SeededContext } from "./types"
import { ProviderV2 } from "@turenlabs/core/provider"
import { ModelV2 } from "@turenlabs/core/model"

/**
 * Durable subagent tasks live behind services the app layer only provides to route handlers,
 * so scenarios that need a real task seed one through the same nodes the HttpApi server builds.
 * The shared memo map keeps these instances identical to the ones serving the request.
 */
let taskSeedLayer: ReturnType<typeof buildTaskSeedLayer> | undefined
function buildTaskSeedLayer(modules: Runtime) {
  return modules.AppNodeBuilderV1.build(
    modules.LayerNode.group([modules.EventV2.node, modules.SessionProjector.node, modules.SessionTask.node]),
  )
}

export function runScenario(options: Options) {
  return (scenario: Scenario) => {
    if (scenario.kind === "todo") return Effect.succeed({ status: "skip", scenario } as Result)
    return runActive(options, scenario).pipe(
      Effect.timeoutOrElse({
        duration: options.scenarioTimeout,
        orElse: () => Effect.die(new Error(`scenario timed out after ${Duration.format(options.scenarioTimeout)}`)),
      }),
      Effect.as({ status: "pass", scenario } as Result),
      // Order matters. `resetState` unlinks the SQLite file, so it must run *after*
      // `Effect.scoped` has closed the scenario scope and finalized the AppLayer's
      // primary + reader connections. Running it inside the scope (as an `ensuring`
      // on the scenario body) deleted the database out from under still-open
      // handles, and the shutdown checkpoint then died with
      // `Failed query: PRAGMA busy_timeout = 5000` on the very first scenario.
      Effect.scoped,
      // Auth mode never builds an instance, so it keeps its previous no-reset behaviour.
      Effect.ensuring(scenario.reset && options.mode !== "auth" ? resetState : Effect.void),
      // Outermost, so a defect raised while closing the scope is recorded as a
      // scenario failure instead of rejecting the whole run.
      Effect.catchCause((cause) => Effect.succeed({ status: "fail" as const, scenario, message: Cause.pretty(cause) })),
    )
  }
}

function runActive(options: Options, scenario: ActiveScenario) {
  if (options.mode === "auth") return runAuth(options, scenario)

  return withContext(options, scenario, "shared", (ctx) =>
    Effect.gen(function* () {
      yield* trace(options, scenario, "request start")
      const result = yield* call(scenario, ctx)
      yield* trace(options, scenario, `response ${result.status}`)
      yield* trace(options, scenario, "expect start")
      yield* scenario.expect(ctx, ctx.state, result)
      yield* trace(options, scenario, "expect done")
    }),
  )
}

function runAuth(options: Options, scenario: ActiveScenario) {
  return Effect.gen(function* () {
    const result = yield* callAuthProbe(scenario, "missing")
    if (scenario.auth === "protected") {
      if (result.status !== 401) throw new Error(`auth expected 401, got ${result.status}`)
      // Valid credentials reach real route work; the enclosing scenario owns its full budget.
      const setup = scenario.authSetup
      if (setup) yield* setup.setup()
      const authed = setup
        ? yield* callAuthProbe(scenario, "valid", Duration.toMillis(options.scenarioTimeout)).pipe(
            Effect.ensuring(setup.cleanup()),
          )
        : yield* callAuthProbe(scenario, "valid", Duration.toMillis(options.scenarioTimeout))
      if (authed.timedOut) throw new Error("valid auth probe timed out")
      if (authed.status === 401) throw new Error("auth rejected valid credentials")
      return
    }

    if (result.status === 401) throw new Error("auth expected public access, got 401")
    if (result.timedOut) throw new Error("auth expected public access, probe timed out")
  })
}

function withContext<A, E>(
  options: Options,
  scenario: ActiveScenario,
  label: string,
  use: (ctx: SeededContext<unknown>) => Effect.Effect<A, E>,
) {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      yield* trace(options, scenario, `${label} context acquire start`)
      const project = scenario.project
      const dir = project
        ? yield* Effect.promise(async () => (await runtime()).tmpdir(projectOptions(project)))
        : undefined
      yield* trace(options, scenario, `${label} context acquire done`)
      return { dir }
    }),
    (ctx) =>
      Effect.gen(function* () {
        yield* trace(options, scenario, `${label} tmpdir cleanup start`)
        yield* Effect.promise(async () => {
          await ctx.dir?.[Symbol.asyncDispose]()
        }).pipe(Effect.ignore)
        yield* trace(options, scenario, `${label} tmpdir cleanup done`)
      }),
  ).pipe(
    Effect.flatMap((context) =>
      Effect.gen(function* () {
        yield* trace(options, scenario, `${label} runtime start`)
        const modules = yield* Effect.promise(() => runtime())
        const scope = yield* Scope.Scope
        const app = yield* Layer.buildWithMemoMap(modules.AppLayer, modules.memoMap, scope)
        yield* trace(options, scenario, `${label} runtime done`)
        const path = context.dir?.path
        const instance = path
          ? yield* trace(options, scenario, `${label} instance load start`).pipe(
              Effect.andThen(
                modules.InstanceStore.Service.use((store) => store.load({ directory: path })).pipe(
                  Effect.provide(app),
                  Effect.catchCause((cause) =>
                    Effect.sleep("100 millis").pipe(
                      Effect.andThen(
                        modules.InstanceStore.Service.use((store) => store.load({ directory: path })).pipe(
                          Effect.provide(app),
                        ),
                      ),
                      Effect.catchCause(() => Effect.failCause(cause)),
                    ),
                  ),
                ),
              ),
              Effect.tap(() => trace(options, scenario, `${label} instance load done`)),
            )
          : undefined
        const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.provideService(modules.InstanceRef, instance), Effect.provide(app))
        const directory = () => {
          if (!context.dir?.path) throw new Error("scenario needs a project directory")
          return context.dir.path
        }
        const base: ScenarioContext = {
          directory: context.dir?.path,
          headers: (extra) => ({
            ...(context.dir?.path ? { "x-forge-directory": context.dir.path } : {}),
            ...extra,
          }),
          file: (name, content) =>
            Effect.promise(() => {
              return Bun.write(`${directory()}/${name}`, content)
            }).pipe(Effect.asVoid),
          session: (input) =>
            run(modules.Session.Service.use((svc) => svc.create({ title: input?.title, parentID: input?.parentID }))),
          sessionGet: (sessionID) =>
            run(modules.Session.Service.use((svc) => svc.get(sessionID))).pipe(
              Effect.catchCause(() => Effect.succeed(undefined)),
            ),
          project: () =>
            Effect.sync(() => {
              if (!instance) throw new Error("scenario needs a project directory")
              return instance.project
            }),
          message: (sessionID, input) =>
            Effect.gen(function* () {
              const info: SessionV1.User = {
                id: MessageID.ascending(),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: "build",
                model: {
                  providerID: ProviderV2.ID.openai,
                  modelID: ModelV2.ID.make("test"),
                },
              }
              const part: SessionV1.TextPart = {
                id: PartID.ascending(),
                sessionID,
                messageID: info.id,
                type: "text",
                text: input?.text ?? "hello",
              }
              yield* run(
                modules.Session.Service.use((svc) =>
                  Effect.gen(function* () {
                    yield* svc.updateMessage(info)
                    yield* svc.updatePart(part)
                  }),
                ),
              )
              return { info, part }
            }),
          messages: (sessionID) =>
            run(modules.Session.Service.use((svc) => svc.messages({ sessionID }).pipe(Effect.orDie))),
          task: (input) =>
            Effect.gen(function* () {
              const description = input?.description ?? "Durable subagent task"
              const parent = yield* base.session({ title: description })
              const seeded = yield* Layer.buildWithMemoMap(
                (taskSeedLayer ??= buildTaskSeedLayer(modules)),
                modules.memoMap,
                scope,
              )
              const assistantMessageID = SessionMessage.ID.create()
              const toolCallID = `call_${assistantMessageID}`
              const model = ModelV2.Ref.make({
                providerID: ProviderV2.ID.make("test"),
                id: ModelV2.ID.make("test"),
              })
              const prepared = yield* Effect.gen(function* () {
                const events = yield* modules.EventV2.Service
                const tasks = yield* modules.SessionTask.Service
                const timestamp = DateTime.makeUnsafe(Date.now())
                yield* events.publish(SessionEvent.Step.Started, {
                  sessionID: parent.id,
                  assistantMessageID,
                  timestamp,
                  agent: "build",
                  model,
                })
                yield* events.publish(SessionEvent.Tool.Input.Started, {
                  sessionID: parent.id,
                  assistantMessageID,
                  callID: toolCallID,
                  timestamp,
                  name: "spawn_agent",
                })
                yield* events.publish(SessionEvent.Tool.Input.Ended, {
                  sessionID: parent.id,
                  assistantMessageID,
                  callID: toolCallID,
                  timestamp,
                  text: "{}",
                })
                yield* events.publish(SessionEvent.Tool.Called, {
                  sessionID: parent.id,
                  assistantMessageID,
                  callID: toolCallID,
                  timestamp,
                  tool: "spawn_agent",
                  input: {},
                  provider: { executed: false },
                })
                return yield* tasks.spawn({
                  actor: modules.SessionTask.Actor.make({
                    sessionID: parent.id,
                    assistantMessageID,
                    toolCallID,
                  }),
                  agent: Agent.ID.make("explore"),
                  model,
                  prompt: Prompt.make({ text: description }),
                  description,
                  authority: modules.SessionTask.Authority.make({
                    parentPermissions: [],
                    ancestorPermissionSets: [],
                    childPermissions: [],
                    hardPermissions: [],
                    writeRoots: [AbsolutePath.make(directory())],
                    commands: [],
                  }),
                })
              }).pipe(Effect.provideService(modules.InstanceRef, instance), Effect.provide(seeded), Effect.orDie)
              return {
                sessionID: parent.id,
                taskID: prepared.task.id,
                childSessionID: prepared.task.childSessionID,
                description: prepared.task.description,
                revision: prepared.task.revision,
              }
            }),
          todos: (sessionID, todos) => run(modules.Todo.Service.use((svc) => svc.update({ sessionID, todos }))),
          worktree: (input) => run(modules.Worktree.Service.use((svc) => svc.create(input).pipe(Effect.orDie))),
          worktreeRemove: (directory) =>
            run(modules.Worktree.Service.use((svc) => svc.remove({ directory })).pipe(Effect.ignore)),
        }
        yield* trace(options, scenario, `${label} seed start`)
        const state = yield* scenario.seed(base)
        yield* trace(options, scenario, `${label} seed done`)
        yield* trace(options, scenario, `${label} use start`)
        const result = yield* use({ ...base, state })
        yield* trace(options, scenario, `${label} use done`)
        return result
      }),
    ),
  )
}

function trace(options: Options, scenario: ActiveScenario, phase: string) {
  return Effect.sync(() => {
    if (!options.trace) return
    console.log(`[trace] ${scenario.name}: ${phase}`)
  })
}

function projectOptions(project: ProjectOptions) {
  return { git: project.git, config: project.config }
}

const resetState = Effect.promise(async () => {
  const modules = await runtime()
  Flag.FORGE_SERVER_PASSWORD = original.FORGE_SERVER_PASSWORD
  Flag.FORGE_SERVER_USERNAME = original.FORGE_SERVER_USERNAME
  await disposeApps()
  await modules.disposeAllInstances()
  await modules.resetDatabase()
  await Bun.sleep(25)
})
