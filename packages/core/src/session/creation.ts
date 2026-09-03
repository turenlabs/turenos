export * as SessionCreation from "./creation"

import { Context, Effect, Layer } from "effect"
import path from "path"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { InstallationVersion } from "../installation/version"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { ProjectV2 } from "../project"
import { ProjectTable } from "../project/sql"
import { SessionV1 } from "../v1/session"
import { WorkspaceV2 } from "../workspace"
import { Slug } from "../util/slug"
import { SessionProjector } from "./projector"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"
import { AgentV2 } from "../agent"

const PLACEHOLDER_PREFIX = "New session - "
const PLACEHOLDER = /^New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** The stand-in name `create` gives a Session nobody has named yet. */
export const placeholderTitle = (at: number) => `${PLACEHOLDER_PREFIX}${new Date(at).toISOString()}`

/**
 * True while a Session still carries the name `create` gave it. Anything else -- a user rename, a
 * subagent's spawn description, a generated title -- is somebody's deliberate choice, and the
 * automatic titler must leave it alone. Owned here so the format has exactly one author.
 */
export const isPlaceholderTitle = (title: string) => PLACEHOLDER.test(title)

export type CreateInput = {
  readonly id?: SessionSchema.ID
  readonly parentID?: SessionSchema.ID
  readonly agent?: AgentV2.ID
  readonly model?: ModelV2.Ref
  readonly title?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly location: Location.Ref
}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionCreation") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const store = yield* SessionStore.Service

    return Service.of({
      create: Effect.fn("SessionCreation.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        const project = yield* projects.resolve(input.location.directory)
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const info = SessionV1.SessionInfo.make({
          id: sessionID,
          parentID: input.parentID,
          slug: Slug.create(),
          version: InstallationVersion,
          projectID: project.id,
          directory: input.location.directory,
          path: path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
          workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
          title: input.title ?? placeholderTitle(now),
          metadata: input.metadata,
          agent: input.agent,
          model: input.model
            ? {
                id: ModelV2.ID.make(input.model.id),
                providerID: input.model.providerID,
                variant: input.model.variant,
              }
            : undefined,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        })
        const projected = yield* events
          .publish(SessionV1.Event.Created, { sessionID, info }, { location: input.location })
          .pipe(
            Effect.as({ type: "created" } as const),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) return Effect.die(defect)
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") return projected.session
        return yield* store
          .get(sessionID)
          .pipe(
            Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die("Session projection missing"))),
          )
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, ProjectV2.node, SessionStore.node, SessionProjector.node],
})
