import { createRenderEffect, untrack, type ParentProps } from "solid-js"
import { useParams } from "@solidjs/router"
import { useGlobal } from "@/context/global"
import { ModelsProvider } from "@/context/models"
import { ServerConnection } from "@/context/server"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider } from "@/context/server-sync"
import { requireServerKey } from "@/utils/session-route"

export function SettingsServerProvider(props: ParentProps) {
  const params = useParams<{ serverKey?: string }>()
  if (!params.serverKey) return props.children

  const global = useGlobal()
  // Untracked: `set` reads store.settings.serverKey, which would otherwise
  // subscribe this effect to the store and instantly stomp manual picks from
  // the settings server picker back to the route's server.
  const serverKey = () => requireServerKey(params.serverKey!)
  createRenderEffect(() => untrack(() => global.settings.server.set(serverKey())))
  const server = () => {
    return global.servers.list().find((item) => ServerConnection.key(item) === serverKey())
  }

  return (
    <ServerSDKProvider server={server}>
      <ServerSyncProvider server={server}>
        <ModelsProvider>{props.children}</ModelsProvider>
      </ServerSyncProvider>
    </ServerSDKProvider>
  )
}
