import { CACHE_CAPACITY } from "./config.ts"
import { normalizeTenantId } from "./tenant.ts"

export interface StoredRecord {
  readonly id: string
  readonly tenantId: string
  readonly body: string
}

/** An in-memory, tenant-scoped record store. */
export class TenantStore {
  private readonly rows = new Map<string, StoredRecord>()

  put(tenant: string, id: string, body: string): StoredRecord {
    const tenantId = normalizeTenantId(tenant)
    if (this.rows.size >= CACHE_CAPACITY) throw new Error("store at capacity")
    const row: StoredRecord = { id, tenantId, body }
    this.rows.set(`${tenantId}/${id}`, row)
    return row
  }

  get(tenant: string, id: string): StoredRecord | undefined {
    return this.rows.get(`${normalizeTenantId(tenant)}/${id}`)
  }

  list(tenant: string): readonly StoredRecord[] {
    const tenantId = normalizeTenantId(tenant)
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId)
  }

  get size(): number {
    return this.rows.size
  }
}
