# Bramblewick

Bramblewick is a small multi-tenant record service used as a deterministic
benchmark fixture. It is intentionally tiny: five TypeScript modules and this
README.

Its codename is **Bramblewick**.

## Layout

- `src/config.ts` — tuning constants for the service.
- `src/tenant.ts` — tenant identifier normalisation.
- `src/auth.ts` — request authentication.
- `src/store.ts` — the tenant-scoped record store.
- `src/metrics.ts` — counters, deliberately independent of tenant handling.
- `src/index.ts` — wiring and the public entry point.

## Invariants

Every tenant-scoped read or write goes through `normalizeTenantId` before it
touches the store. The metrics module never sees tenant identifiers at all.
