// The sidecar receives these over IPC. Anything left in its environment is inherited by
// agent shells, PTYs, LSP and MCP servers, which would let them drive the server or open the vault.
const IPC_SECRETS = [
  "FORGE_SERVER_PASSWORD",
  "FORGE_BETA_SERVER_PASSWORD",
  "FORGE_SECRET_VAULT_KEY",
  "FORGE_SECRET_VAULT_KEY_ID",
]

export function withoutIpcSecrets(env: Record<string, string>) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !IPC_SECRETS.includes(key)))
}
