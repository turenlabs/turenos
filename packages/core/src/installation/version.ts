declare global {
  const FORGE_VERSION: string
  const FORGE_CHANNEL: string
}

export const InstallationVersion = typeof FORGE_VERSION === "string" ? FORGE_VERSION : "local"
export const InstallationChannel = typeof FORGE_CHANNEL === "string" ? FORGE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
