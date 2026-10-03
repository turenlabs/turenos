import { checkDirectory } from "../response-validation"
import { addCustom, auth, authorize, complete, connectKey } from "./auth"
import { catalog } from "./catalog"
import { providerConnection } from "./request"
import type { AuthMethod } from "./validation"

export function createProviders(options: { url: URL; headers: Headers; signal: AbortSignal }) {
  const { request, secure } = providerConnection(options)
  return {
    async list(selected: string) {
      checkDirectory(selected)
      return catalog(request, selected)
    },
    connectKey: (providerID: string, key: string, metadata?: Record<string, string>, signal?: AbortSignal) =>
      connectKey(request, providerID, key, metadata, signal),
    addCustom: (
      input: { providerID: string; name: string; baseURL: string; modelID: string; modelName: string; key?: string },
      directory: string,
      signal?: AbortSignal,
    ) => addCustom(request, secure, input, directory, signal),
    auth: (selected: string): Promise<Record<string, AuthMethod[]>> => auth(request, selected),
    authorize: (
      selected: string,
      providerID: string,
      method: number,
      inputs?: Record<string, string>,
      signal?: AbortSignal,
    ) => authorize(request, selected, providerID, method, inputs, signal),
    complete: (selected: string, providerID: string, method: number, code?: string, signal?: AbortSignal) =>
      complete(request, selected, providerID, method, code, signal),
  }
}
