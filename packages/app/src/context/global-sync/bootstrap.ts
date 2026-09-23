import type {
  Config,
  ForgeClient,
  Path,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
} from "@turenlabs/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@turenlabs/core/util/path"
import { retry } from "@turenlabs/core/util/retry"
import { batch } from "solid-js"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State, VcsCache } from "./types"
import type { ServerSession } from "../server-session"
import { cmp, normalizeAgentList, normalizeProviderList } from "./utils"
import { formatServerError } from "@/utils/server-errors"
import { isCancelledError, QueryClient, queryOptions } from "@tanstack/solid-query"
import { NormalizedProviderListResponse } from "@turenlabs/session-ui/context"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import type { ProviderAuthResponse } from "@turenlabs/sdk/v2/client"
import { startupTrace } from "@/utils/startup-trace"

type GlobalStore = {
  ready: boolean
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 50)
    if (typeof requestAnimationFrame !== "function") return
    requestAnimationFrame(() => {
      setTimeout(() => {
        clearTimeout(timer)
        finish()
      }, 0)
    })
  })
}

// Superseding a bootstrap, or leaving the directory, cancels whatever it had in
// flight — TanStack rejects those queries with a CancelledError and an aborted
// fetch with an AbortError. Neither is a failure: nothing went wrong, the answer
// simply stopped being wanted. Counting them raised "Failed to reload <project>"
// over ordinary navigation, and because the directory only reaches "complete"
// when this list is empty, a cancelled reload also stranded it at "partial".
//
// Use TanStack's own predicate rather than matching a name: CancelledError is
// built as `super("CancelledError")`, so the string is its *message* and its
// name is plain "Error". Checking `name` silently never matches.
function isCancellation(error: unknown) {
  if (isCancelledError(error)) return true
  if (typeof error !== "object" || error === null) return false
  return (error as { name?: unknown }).name === "AbortError"
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list
    .filter((item): item is PromiseRejectedResult => item.status === "rejected")
    .map((item) => item.reason)
    .filter((reason) => !isCancellation(reason))
}

const providerRev = new Map<string, number>()

export function clearProviderRev(scope: ServerScope, directory: string) {
  providerRev.delete(ScopedKey.from(scope, directory))
}

function runAll(list: Array<() => Promise<unknown>>) {
  return Promise.allSettled(list.map((item) => item()))
}

function showErrors(input: {
  errors: unknown[]
  title: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
}) {
  if (input.errors.length === 0) return
  const message = formatServerError(input.errors[0], input.translate)
  const more = input.errors.length > 1 ? input.formatMoreCount(input.errors.length - 1) : ""
  showToast({
    variant: "error",
    title: input.title,
    description: message + more,
  })
}

export const loadGlobalConfigQuery = (scope: ServerScope, sdk: ForgeClient) =>
  queryOptions({
    queryKey: [scope, "config"],
    queryFn: () => retry(() => sdk.global.config.get().then((x) => x.data!)),
  })

export const loadProjectsQuery = (scope: ServerScope, sdk: ForgeClient) =>
  queryOptions({
    queryKey: [scope, "project"],
    queryFn: () =>
      retry(() =>
        sdk.project.list().then((x) => {
          return (x.data ?? [])
            .filter((p) => !!p?.id)
            .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
            .slice()
            .sort((a, b) => cmp(a.id, b.id))
        }),
      ),
  })

export async function bootstrapGlobal(input: {
  serverSDK: ForgeClient
  scope: ServerScope
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  // Config, provider, and path have independent queries in ServerSyncProvider.
  // Global readiness only needs project identity; waiting for provider probes here
  // blocks restored-tab navigation and duplicates the same requests.
  await runAll([
    () =>
      input.queryClient
        .fetchQuery(loadProjectsQuery(input.scope, input.serverSDK))
        .then((data) => input.setGlobalStore("project", data)),
  ])
  // showErrors({
  //   errors: errors(),
  //   title: input.requestFailedTitle,
  //   translate: input.translate,
  //   formatMoreCount: input.formatMoreCount,
  // })
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

function projectID(directory: string, projects: Project[]) {
  return projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))?.id
}

function mergeSession(setStore: SetStoreFunction<State>, session: Session) {
  setStore("session", (list) => {
    const next = list.slice()
    const idx = next.findIndex((item) => item.id >= session.id)
    if (idx === -1) return [...next, session]
    if (next[idx]?.id === session.id) {
      next[idx] = session
      return next
    }
    next.splice(idx, 0, session)
    return next
  })
}

function warmSessions(input: {
  ids: string[]
  store: Store<State>
  setStore: SetStoreFunction<State>
  sdk: ForgeClient
}) {
  const known = new Set(input.store.session.map((item) => item.id))
  const ids = [...new Set(input.ids)].filter((id) => !!id && !known.has(id))
  if (ids.length === 0) return Promise.resolve()
  return Promise.all(
    ids.map((sessionID) =>
      retry(() => input.sdk.session.get({ sessionID })).then((x) => {
        const session = x.data
        if (!session?.id) return
        mergeSession(input.setStore, session)
      }),
    ),
  ).then(() => undefined)
}

export const loadProvidersQuery = (scope: ServerScope, directory: string | null, sdk: ForgeClient) =>
  queryOptions({
    queryKey: [scope, directory, "providers"],
    queryFn: () => retry(() => sdk.provider.list().then((x) => normalizeProviderList(x.data!))),
  })

export const loadAgentsQuery = (scope: ServerScope, directory: string | null, sdk: ForgeClient) =>
  queryOptions({
    queryKey: [scope, directory, "agents"],
    queryFn: () => retry(() => sdk.app.agents().then((x) => normalizeAgentList(x.data))),
  })

export const loadPathQuery = (scope: ServerScope, directory: string | null, sdk: ForgeClient) =>
  queryOptions<Path>({
    queryKey: [scope, directory, "path"],
    queryFn: () => retry(() => sdk.path.get().then((x) => x.data!)),
  })

export async function bootstrapDirectory(input: {
  directory: string
  scope: ServerScope
  sdk: ForgeClient
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
    provider: NormalizedProviderListResponse
  }
  queryClient: QueryClient
  session?: ServerSession
}) {
  const loading = input.store.status !== "complete"
  const seededProject = projectID(input.directory, input.global.project)
  const seededPath = input.global.path.directory === input.directory ? input.global.path : undefined
  if (seededProject) input.setStore("project", seededProject)
  if (seededPath) input.setStore("path", seededPath)
  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    input.setStore("config", reconcile(input.global.config, { merge: false }))
  }
  if (loading) input.setStore("status", "partial")

  const revKey = ScopedKey.from(input.scope, input.directory)
  const rev = (providerRev.get(revKey) ?? 0) + 1
  providerRev.set(revKey, rev)
  // Keep one revision for the whole bootstrap, including transient retries. A retry from an
  // older bootstrap must remain older than a newer bootstrap that completed meanwhile.
  const snapshotRevision = input.session?.beginStatusSnapshot()
  return (async () => {
    const startedAt = performance.now()
    startupTrace("bootstrap", "directory.started", { directory: input.directory })
    const slow = [
      () => Promise.resolve(input.loadSessions(input.directory)),
      // fetchQuery, not ensureQueryData: the paths that refresh store.agent after
      // server-side invalidation (instance disposal re-bootstrap, `config.updated`)
      // rely on it actually refetching — a cache hit made edited agents invisible
      // until an app restart.
      () =>
        input.queryClient
          .fetchQuery(loadAgentsQuery(input.scope, input.directory, input.sdk))
          .then((data) => input.setStore("agent", data)),
      () =>
        retry(() => input.sdk.config.get().then((x) => input.setStore("config", reconcile(x.data!, { merge: false })))),
      () =>
        retry(() => {
          return input.sdk.session.status().then((x) => {
            if (!input.session) {
              input.setStore("session_status", x.data!)
              return
            }
            const statuses = x.data ?? {}
            input.session.setStatuses(input.directory, statuses, snapshotRevision)
          })
        }),
      !seededProject &&
        (() => retry(() => input.sdk.project.current()).then((x) => input.setStore("project", x.data!.id))),
      !seededPath &&
        (() =>
          input.queryClient.ensureQueryData(loadPathQuery(input.scope, input.directory, input.sdk)).then((data) => {
            const next = projectID(data.directory ?? input.directory, input.global.project)
            if (next) input.setStore("project", next)
          })),
      () =>
        retry(() =>
          input.sdk.vcs.get().then((x) => {
            const next = x.data ?? input.store.vcs
            input.setStore("vcs", next)
            if (next) input.vcsCache.setStore("value", next)
          }),
        ),
      () => retry(() => input.sdk.command.list().then((x) => input.setStore("command", x.data ?? []))),
      () =>
        retry(() =>
          input.sdk.permission.list().then((x) => {
            const ids = (x.data ?? []).map((perm) => perm?.sessionID).filter((id): id is string => !!id)
            const grouped = groupBySession(
              (x.data ?? []).filter((perm): perm is PermissionRequest => !!perm?.id && !!perm.sessionID),
            )
            const apply = () =>
              batch(() => {
                const current = input.session?.data.permission ?? input.store.permission
                for (const sessionID of Object.keys(current)) {
                  if (grouped[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory !== input.directory) continue
                  if (input.session) input.session.set("permission", sessionID, [])
                  if (!input.session) input.setStore("permission", sessionID, [])
                }
                for (const [sessionID, permissions] of Object.entries(grouped)) {
                  const value = reconcile(
                    permissions.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  )
                  if (input.session) input.session.set("permission", sessionID, value)
                  if (!input.session) input.setStore("permission", sessionID, value)
                }
              })
            if (input.session) {
              apply()
              return
            }
            return warmSessions({ ids, store: input.store, setStore: input.setStore, sdk: input.sdk }).then(apply)
          }),
        ),
      () =>
        retry(() =>
          input.sdk.v2.question.request.list().then((x) => {
            const questions = x.data?.data ?? []
            const ids = questions.map((question) => question.sessionID)
            const grouped = groupBySession(questions.filter((q): q is QuestionRequest => !!q.id && !!q.sessionID))
            const apply = () =>
              batch(() => {
                const current = input.session?.data.question ?? input.store.question
                for (const sessionID of Object.keys(current)) {
                  if (grouped[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory !== input.directory) continue
                  if (input.session) input.session.set("question", sessionID, [])
                  if (!input.session) input.setStore("question", sessionID, [])
                }
                for (const [sessionID, questions] of Object.entries(grouped)) {
                  const value = reconcile(
                    questions.filter((q) => !!q?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  )
                  if (input.session) input.session.set("question", sessionID, value)
                  if (!input.session) input.setStore("question", sessionID, value)
                }
              })
            if (input.session) {
              apply()
              return
            }
            return warmSessions({ ids, store: input.store, setStore: input.setStore, sdk: input.sdk }).then(apply)
          }),
        ),
      () =>
        input.queryClient.fetchQuery(loadProvidersQuery(input.scope, input.directory, input.sdk)).catch((err) => {
          if (isCancellation(err)) return
          // Provider discovery is an optional catalog refresh, not a project reload. The
          // child store falls back to the last global catalog when this request times out;
          // surfacing one project-level toast per mounted directory creates an alert storm
          // while the project, sessions, and filesystem have all loaded successfully.
          console.warn("Failed to refresh project provider catalog", input.directory, err)
        }),
    ].filter(Boolean) as (() => Promise<any>)[]

    await waitForPaint()
    const slowErrs = errors(await runAll(slow))
    startupTrace("bootstrap", "directory.completed", {
      directory: input.directory,
      durationMs: Math.round(performance.now() - startedAt),
      errors: slowErrs.length,
    })
    if (slowErrs.length > 0) {
      console.error("Failed to finish bootstrap instance", slowErrs[0])
      const project = getFilename(input.directory)
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project }),
        description: formatServerError(slowErrs[0], input.translate),
      })
    }

    if (loading && slowErrs.length === 0) input.setStore("status", "complete")
  })()
}
