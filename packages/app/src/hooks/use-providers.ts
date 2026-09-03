import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import type { Accessor } from "solid-js"
import { selectProviderCatalog } from "./provider-catalog"
import { isRemovedProvider, popularProviders } from "./provider-visibility"

export { isRemovedProvider, popularProviders } from "./provider-visibility"

const popularProviderSet = new Set(popularProviders)

export function useProviders(directory?: Accessor<string | undefined>) {
  const serverSync = useServerSync()
  const params = useParams()
  const dir = () => (directory ? directory() : decode64(params.dir))
  const providers = () => {
    const value = dir()
    const projectStore = value ? serverSync().child(value)[0] : undefined
    if (directory)
      return selectProviderCatalog({
        explicit: true,
        directory: value,
        catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
      })
    return selectProviderCatalog({
      explicit: false,
      directory: value,
      catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
      global: serverSync().data.provider,
    })
  }
  const excluded = () => new Set(serverSync().provider.excluded())
  const all = () => new Map([...providers().all].filter(([id]) => !isRemovedProvider(id)))
  return {
    all,
    default: () =>
      Object.fromEntries(
        Object.entries(providers().default).filter(
          ([, provider]) => !isRemovedProvider(provider) && !excluded().has(provider),
        ),
      ),
    popular: () =>
      pipe(
        all(),
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id) && !excluded().has(p.id)),
        (v) => Array.from(v),
      ),
    connected: () => {
      const connected = new Set(providers().connected)
      const hidden = excluded()
      return pipe(
        all(),
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => connected.has(p.id) && !hidden.has(p.id)),
        (v) => Array.from(v),
      )
    },
    paid: () => {
      const connected = new Set(providers().connected)
      const hidden = excluded()
      return [...Iterable.filter(all(), ([id]) => connected.has(id) && !hidden.has(id))]
    },
  }
}
