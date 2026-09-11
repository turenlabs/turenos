import type { SshServersState } from "@turenlabs/app/ssh/types"

export function readySshConnections(state?: SshServersState) {
  return (state?.servers ?? []).flatMap((item) => {
    if (item.runtime.kind !== "ready") return []
    return [
      {
        displayName: item.config.displayName ?? item.config.hostname ?? item.config.host,
        label: "SSH",
        type: "ssh" as const,
        // `ServerConnection.key` produces `ssh:${conn.host}` - the id slice
        // keeps the connection key identical to the managed server id.
        host: item.config.id.slice("ssh:".length),
        http: {
          url: item.runtime.url,
          username: item.runtime.username ?? undefined,
          password: item.runtime.password ?? undefined,
        },
      },
    ]
  })
}
