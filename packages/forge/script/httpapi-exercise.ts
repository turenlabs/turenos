import { randomBytes, randomUUID } from "node:crypto"

// Direct runs (e.g. --include filters) skip httpapi-gates.ts, which injects these.
process.env.FORGE_SECRET_VAULT_KEY_ID ??= `httpapi-${randomUUID()}`
process.env.FORGE_SECRET_VAULT_KEY ??= randomBytes(32).toString("base64")

await import("../test/server/httpapi-exercise/index")
