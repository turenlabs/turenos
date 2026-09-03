import { authenticate, type AuthRequest } from "./auth.ts"
import { defaultConfig } from "./config.ts"
import { Counters } from "./metrics.ts"
import { TenantStore } from "./store.ts"

export function createService() {
  const config = defaultConfig()
  const store = new TenantStore()
  const counters = new Counters()

  return {
    config,
    write(request: AuthRequest, id: string, body: string) {
      const principal = authenticate(request)
      counters.increment("requests")
      return store.put(principal.tenantId, id, body)
    },
    read(request: AuthRequest, id: string) {
      const principal = authenticate(request)
      counters.increment("requests")
      const row = store.get(principal.tenantId, id)
      counters.increment(row ? "cache_hits" : "cache_misses")
      return row
    },
    metrics: () => counters.snapshot(),
  }
}
