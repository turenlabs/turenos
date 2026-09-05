type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.FORGE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

/**
 * True only in dev builds. `FORGE_CHANNEL` is a build-time `define` (see
 * `electron.vite.config.ts`), so this folds to a literal and the bundler can
 * drop anything gated on it. Use this - not `app.isPackaged` - for code that
 * must not exist in a shipped build; `isPackaged` is a runtime check and keeps
 * the code in the bundle.
 */
export const IS_DEV: boolean = CHANNEL === "dev"

// Production artifacts are mirrored to public GitHub Releases; no client token is needed.
export const UPDATER_ENABLED = CHANNEL === "prod"
