import { createEffect, createRoot, getOwner, onCleanup } from "solid-js"
import { createSimpleContext } from "@turenlabs/ui/context"
import type { PermissionRequest } from "@turenlabs/sdk/v2/client"
import type { ServerSDK } from "@/context/server-sdk"
import { useParams, useSearchParams } from "@solidjs/router"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { type DraftTab, useTabs } from "./tabs"
import { useSettings } from "./settings"
import { requireServerKey } from "@/utils/session-route"
import type { ServerScope } from "@/utils/server-scope"

type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "always" | "reject"
  directory?: string
}) => void

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  gate: false,
  init: () => {
    const params = useParams<{ serverKey?: string }>()
    const [search] = useSearchParams<{ draftId?: string }>()
    const global = useGlobal()
    const server = useServer()
    const tabs = useTabs()
    const settings = useSettings()
    const owner = getOwner()
    const states = new Map<ServerScope, { key: ServerConnection.Key; dispose: () => void; state: PermissionState }>()

    const activeDraft = () =>
      tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId)

    const activeServer = () => {
      if (params.serverKey && settings.general.newLayoutDesigns()) return requireServerKey(params.serverKey)
      return activeDraft()?.server ?? server.key
    }

    const ensure = (key: ServerConnection.Key) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
      if (!conn) throw new Error(`Permission server not found: ${key}`)
      const ctx = global.ensureServerCtx(conn)
      const existing = states.get(ctx.sdk.scope)
      if (existing && global.servers.list().some((item) => ServerConnection.key(item) === existing.key)) {
        return existing.state
      }
      if (existing) {
        existing.dispose()
        states.delete(ctx.sdk.scope)
      }
      const root = createRoot(
        (dispose) => ({ key, dispose, state: createServerPermissionState(ctx.sdk) }),
        owner ?? undefined,
      )
      states.set(ctx.sdk.scope, root)
      return root.state
    }

    createEffect(() => {
      global.servers
        .list()
        .filter((conn) => global.servers.health[ServerConnection.key(conn)]?.healthy === true)
        .forEach((conn) => ensure(ServerConnection.key(conn)))
    })

    createEffect(() => {
      const list = global.servers.list()
      const healthy = list.filter((conn) => global.servers.health[ServerConnection.key(conn)]?.healthy === true)
      const keys = new Set(healthy.map(ServerConnection.key))
      states.forEach((value, scope) => {
        if (keys.has(value.key)) return
        value.dispose()
        states.delete(scope)
        const replacement = healthy.find((conn) => server.scope(ServerConnection.key(conn)) === scope)
        if (replacement) ensure(ServerConnection.key(replacement))
      })
    })

    onCleanup(() => states.forEach((value) => value.dispose()))

    let lastSelected: PermissionState | undefined
    const selected = () => {
      const key = activeServer()
      if (global.servers.list().some((conn) => ServerConnection.key(conn) === key)) lastSelected = ensure(key)
      if (lastSelected) return lastSelected
      return ensure(server.key)
    }

    return {
      ready: () => true,
      ensureServerState: (key: ServerConnection.Key) => ensure(key),
      respond(input: Parameters<PermissionRespondFn>[0]) {
        selected().respond(input)
      },
      autoResponds(_permission: PermissionRequest, _directory?: string) {
        return false
      },
    }
  },
})

type PermissionState = ReturnType<typeof createServerPermissionState>

function createServerPermissionState(sdk: ServerSDK) {
  const respond: PermissionRespondFn = (request) => {
    sdk.client.permission.respond(request).catch(() => undefined)
  }
  return {
    respond,
    autoResponds(_permission: PermissionRequest, _directory?: string) {
      return false
    },
  }
}
