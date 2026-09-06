import { createResource, ErrorBoundary, Show, Suspense } from "solid-js"
import { Schema } from "effect"
import { Whiteboard } from "@turenlabs/schema/whiteboard"
import { WhiteboardCanvas, type WhiteboardTransport } from "@/components/whiteboard"
import { useServerSDK } from "@/context/server-sdk"
import { ScopedKey } from "@/utils/server-scope"
import { useTheme } from "@turenlabs/ui/theme/context"

const snapshot = Schema.decodeUnknownSync(Whiteboard.Snapshot)
const presence = Schema.decodeUnknownSync(Whiteboard.PresenceSnapshot)
const event = Schema.decodeUnknownSync(Whiteboard.Events)

export default function SessionWhiteboard(props: { sessionID: string; active: boolean }) {
  const sdk = useServerSDK()
  const theme = useTheme()
  const key = () => ScopedKey.from(sdk().scope, "whiteboard", props.sessionID)
  const [connection, { refetch }] = createResource(
    () => ({ sdk: sdk(), sessionID: props.sessionID, key: key() }),
    async (source) => {
      const client = (await source.sdk.createProtocolClient())["server.whiteboard"]
      const sessionID = source.sessionID
      const transport: WhiteboardTransport = {
        get: async (signal) => snapshot(await client.get({ sessionID }, { signal })),
        update: async (input, signal) => snapshot(await client.update({ sessionID, ...input }, { signal })),
        presence: async (input, signal) => presence(await client.presence({ sessionID, ...input }, { signal })),
        async *events(signal) {
          for await (const value of client.events({ sessionID }, { signal })) yield event(value)
        },
      }
      return { key: source.key, sessionID, transport }
    },
  )
  return (
    <ErrorBoundary
      fallback={(error, reset) => {
        console.error("[whiteboard] panel failed", error)
        return (
          <div class="flex h-full flex-col items-center justify-center gap-3 text-13-regular text-v2-text-muted">
            <p>Whiteboard could not connect to this server.</p>
            <button
              type="button"
              class="rounded-control border border-v2-border-border-base px-3 py-1.5"
              onClick={() => {
                reset()
                void refetch()
              }}
            >
              Retry
            </button>
          </div>
        )
      }}
    >
      <Suspense
        fallback={
          <div class="flex h-full items-center justify-center text-13-regular text-v2-text-muted">
            Opening whiteboard...
          </div>
        }
      >
        <Show when={connection()?.key === key() ? connection() : undefined} keyed>
          {(source) => (
            <WhiteboardCanvas
              sessionID={source.sessionID}
              storageKey={source.key}
              transport={source.transport}
              theme={theme.mode() === "dark" ? "dark" : "light"}
              active={props.active}
            />
          )}
        </Show>
      </Suspense>
    </ErrorBoundary>
  )
}
