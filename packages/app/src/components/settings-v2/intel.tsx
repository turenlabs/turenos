import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { useGlobal } from "@/context/global"
import { ServerConnection, useServer } from "@/context/server"
import { intelApi, type IntelApi } from "@/pages/home/intel-api"
import { IntelSettings } from "@/pages/home/intel-settings"
import { localLoopServer } from "@/pages/loops/local-server"
import { SettingsPageHeaderV2 } from "./page-header"

export function SettingsIntelV2() {
  const server = useServer()
  const connection = createMemo(() => localLoopServer(server.list, server.scope))

  return (
    <>
      <SettingsPageHeaderV2
        title="Threat intelligence"
        description="Manage feeds for your local security digest. Changes apply to future feed polls."
        scope="Local server"
      />
      <div class="settings-v2-tab-body" data-component="settings-intel">
        <Show
          when={connection()}
          keyed
          fallback={
            <div class="text-[13px] leading-5 text-v2-text-text-muted">
              <p class="text-v2-text-text-base">Local server unavailable</p>
              <p>Threat intelligence runs only on your local TurenOS server. Start it to manage feeds.</p>
            </div>
          }
        >
          {(current) => <SettingsIntelContent connection={current} />}
        </Show>
      </div>
    </>
  )
}

function SettingsIntelContent(props: { connection: ServerConnection.Any }) {
  const global = useGlobal()
  const [api, setApi] = createSignal<IntelApi>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const mounted = { value: true }
  onCleanup(() => {
    mounted.value = false
  })

  async function connect() {
    if (loading() || !mounted.value) return
    setLoading(true)
    setError(undefined)
    try {
      const ctx = global.ensureServerCtx(props.connection)
      const protocol = await ctx.sdk.createProtocolClient()
      if (mounted.value) setApi(intelApi(protocol))
    } catch (startupError) {
      if (mounted.value)
        setError(startupError instanceof Error ? startupError.message : "Could not connect to threat intelligence.")
    } finally {
      if (mounted.value) setLoading(false)
    }
  }

  onMount(() => {
    void connect()
  })

  return (
    <div aria-busy={loading()}>
      <Show when={loading()}>
        <p class="text-[13px] text-v2-text-text-muted">Connecting to local server…</p>
      </Show>
      <Show when={error()}>
        {(message) => (
          <div role="alert" class="flex flex-wrap items-center gap-3 text-[13px] text-v2-text-text-muted">
            <p>{message()}</p>
            <ButtonV2 variant="outline" size="normal" onClick={() => void connect()} disabled={loading()}>
              Retry
            </ButtonV2>
          </div>
        )}
      </Show>
      <Show when={api()}>{(client) => <IntelSettings api={client()} />}</Show>
    </div>
  )
}
