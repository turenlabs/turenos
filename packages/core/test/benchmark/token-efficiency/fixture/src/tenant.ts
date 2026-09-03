/** Tenant identifier handling for the Bramblewick service. */

export class InvalidTenantError extends Error {
  constructor(raw: string) {
    super(`invalid tenant id: ${JSON.stringify(raw)}`)
    this.name = "InvalidTenantError"
  }
}

/**
 * Canonicalise a raw tenant identifier.
 *
 * Trims surrounding whitespace, lowercases, and collapses internal runs of
 * separators to a single hyphen. Throws {@link InvalidTenantError} when the
 * result would be empty.
 */
export function normalizeTenantId(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  const collapsed = trimmed.replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "")
  if (collapsed.length === 0) throw new InvalidTenantError(raw)
  return collapsed
}

export function isSameTenant(left: string, right: string): boolean {
  return normalizeTenantId(left) === normalizeTenantId(right)
}
