import { ServerConnection } from "@/context/server"
import { ServerScope } from "@/utils/server-scope"

export function localLoopServer(
  connections: readonly ServerConnection.Any[],
  scope: (key: ServerConnection.Key) => ServerScope,
) {
  return connections.find((connection) => scope(ServerConnection.key(connection)) === ServerScope.local)
}
