import { SETTINGS_STORE } from "./store-keys"

export function rendererStoreName(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) throw new Error("Invalid store name")
  // Repeated dots are safe without path separators and occur in generated workspace store names.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new Error("Invalid store name")
  if (value === SETTINGS_STORE || value === "forge.updater") {
    throw new Error("This store is only available through its typed IPC API")
  }
  return value
}
