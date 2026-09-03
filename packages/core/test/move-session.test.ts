import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { MoveSession } from "@turenlabs/core/control-plane/move-session"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Project } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { ProjectDirectories } from "@turenlabs/core/project/directories"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionTable } from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { SessionTaskTable } from "@turenlabs/core/session/task.sql"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Prompt } from "@turenlabs/core/session/prompt"
import { AgentV2 } from "@turenlabs/core/agent"
import { WorkspaceV2 } from "@turenlabs/core/workspace"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      MoveSession.node,
      Database.node,
      EventV2.node,
      ProjectDirectories.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
    ]),
  ),
)

function abs(input: string) {
  return AbsolutePath.make(input)
}

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.autocrlf false`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@forge.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await fs.writeFile(path.join(directory, "tracked.txt"), "initial\n")
  await $`git add tracked.txt`.cwd(directory).quiet()
  await $`git commit -m root`.cwd(directory).quiet()
}

describe("MoveSession", () => {
  it.live("rejects a task root before capturing, applying, or discarding file changes", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const destination = abs(`${root.path}-task-guard-destination`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(destination, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${destination} HEAD`.cwd(root.path).quiet())
      const moved = abs(yield* Effect.promise(() => fs.realpath(destination)))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "must-stay-at-source\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "untracked.txt"), "must-not-copy\n"))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_task_guard")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "move-task-guard",
          directory: source,
          title: "move task guard",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTaskTable)
        .values({
          id: SessionTaskV2.ID.make("tsk_move_task_guard"),
          root_session_id: sessionID,
          parent_session_id: sessionID,
          child_session_id: SessionV2.ID.make("ses_move_task_guard_child"),
          actor_session_id: sessionID,
          actor_assistant_message_id: SessionMessage.ID.make("msg_move_task_guard"),
          actor_tool_call_id: "call_move_task_guard",
          agent: AgentV2.ID.make("explore"),
          prompt: Prompt.make({ text: "guard" }),
          description: "guard",
          depth: 1,
          status: "starting",
          revision: 0,
          parent_permissions: [],
          ancestor_permission_sets: [],
          child_permissions: [],
          hard_permissions: [],
          write_roots: [source],
          commands: [],
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      const movedExit = yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: moved }, moveChanges: true }),
      ).pipe(Effect.exit)

      expect(movedExit._tag).toBe("Failure")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe(
        "must-stay-at-source\n",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(source, "untracked.txt")).exists())).toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "tracked.txt"), "utf8"))).toBe("initial\n")
      expect(yield* Effect.promise(() => Bun.file(path.join(moved, "untracked.txt")).exists())).toBe(false)
      expect(
        yield* db
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ directory: source })
    }),
  )

  it.live("moves session changes to another project directory", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const destination = abs(`${root.path}-move-destination`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(destination, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${destination} HEAD`.cwd(root.path).quiet())
      const moved = abs(yield* Effect.promise(() => fs.realpath(destination)))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "changed\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "untracked.txt"), "new\n"))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "move",
          directory: source,
          title: "move",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      const seen: EventV2.Payload[] = []
      const unsubscribe = yield* EventV2.Service.use((events) =>
        events.listen((event) => Effect.sync(() => seen.push(event))),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: moved }, moveChanges: true }),
      )

      // This service is global and its route carries no Location middleware, so
      // the envelope has to be set explicitly. The destination is the payload;
      // the envelope routes the frame to the instance the Session is leaving,
      // which is the one still listing a Session that is no longer there. An
      // unlocated frame reaches no per-instance stream at all — see the filter
      // in packages/forge/src/server/routes/instance/httpapi/handlers/event.ts.
      const relocations = seen.filter((event) => event.type === SessionEvent.Moved.type)
      expect(relocations).toHaveLength(1)
      expect(relocations[0]!.location?.directory).toBe(source)

      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "tracked.txt"), "utf8"))).toBe("changed\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "untracked.txt"), "utf8"))).toBe("new\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("initial\n")
      expect(yield* Effect.promise(() => Bun.file(path.join(source, "untracked.txt")).exists())).toBe(false)
      expect(
        yield* db
          .select({ directory: SessionTable.directory, path: SessionTable.path })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ directory: moved, path: "" })
    }),
  )

  it.live("moves within a checkout without transferring existing changes", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const destination = abs(path.join(source, "packages"))
      yield* Effect.promise(() => fs.mkdir(destination))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "changed\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "untracked.txt"), "new\n"))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_nested")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "move-nested",
          directory: source,
          title: "move nested",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: destination }, moveChanges: true }),
      )

      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("changed\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "untracked.txt"), "utf8"))).toBe("new\n")
      expect(
        yield* db
          .select({ directory: SessionTable.directory, path: SessionTable.path })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ directory: destination, path: "packages" })
    }),
  )

  it.live("retains the session's workspace association across a move", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const destination = abs(path.join(source, "packages"))
      yield* Effect.promise(() => fs.mkdir(destination))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_workspace")
      const workspaceID = WorkspaceV2.ID.make("wrk_move_workspace")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          workspace_id: workspaceID,
          slug: "move-workspace",
          directory: source,
          title: "move workspace",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: destination } }),
      )

      expect(
        yield* db
          .select({ workspaceID: SessionTable.workspace_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ workspaceID })
    }),
  )

  it.live("moves nested session changes without cleaning unrelated files", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const sourceDirectory = abs(path.join(source, "packages"))
      yield* Effect.promise(() => fs.mkdir(sourceDirectory))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "tracked.txt"), "initial\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "staged.txt"), "initial\n"))
      yield* Effect.promise(() => $`git add packages/tracked.txt packages/staged.txt`.cwd(source).quiet())
      yield* Effect.promise(() => $`git commit -m packages`.cwd(source).quiet())
      const destination = abs(`${root.path}-move-nested-destination`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(destination, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${destination} HEAD`.cwd(source).quiet())
      const moved = abs(path.join(yield* Effect.promise(() => fs.realpath(destination)), "packages"))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "tracked.txt"), "changed\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "staged.txt"), "staged\n"))
      yield* Effect.promise(() => $`git add packages/staged.txt`.cwd(source).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "untracked.txt"), "new\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "unrelated\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "untracked.txt"), "unrelated\n"))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_nested_checkout")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "move-nested-checkout",
          directory: sourceDirectory,
          title: "move nested checkout",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      const seen: EventV2.Payload[] = []
      const unsubscribe = yield* EventV2.Service.use((events) =>
        events.listen((event) => Effect.sync(() => seen.push(event))),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: moved }, moveChanges: true }),
      )

      // The envelope routes to the placement the Session is leaving, which here
      // is the subdirectory the Session was pinned to rather than the checkout.
      const relocations = seen.filter((event) => event.type === SessionEvent.Moved.type)
      expect(relocations).toHaveLength(1)
      expect(relocations[0]!.location?.directory).toBe(sourceDirectory)

      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "tracked.txt"), "utf8"))).toBe("changed\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "staged.txt"), "utf8"))).toBe("staged\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "untracked.txt"), "utf8"))).toBe("new\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(sourceDirectory, "tracked.txt"), "utf8"))).toBe(
        "initial\n",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(sourceDirectory, "untracked.txt")).exists())).toBe(false)
      expect(yield* Effect.promise(() => fs.readFile(path.join(sourceDirectory, "staged.txt"), "utf8"))).toBe(
        "staged\n",
      )
      expect(yield* Effect.promise(() => $`git status --porcelain -- packages/staged.txt`.cwd(source).text())).toBe(
        "M  packages/staged.txt\n",
      )
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("unrelated\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "untracked.txt"), "utf8"))).toBe("unrelated\n")
    }),
  )
})
