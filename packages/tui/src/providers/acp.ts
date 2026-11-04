import type { AcpLoginState } from "@turenlabs/client/acp-login"
import { invalid } from "../response-validation"
import type { ProviderRequest } from "./request"
import { array, id, record, text } from "./validation"

/** ACP uses its own native login lifecycle, rather than the API-key/OAuth plugin routes. */
export function acp(request: ProviderRequest) {
  return {
    authorize: async (directory: string) =>
      state(
        await request("/provider/antigravity-acp/auth", {
          method: "POST",
          directory,
          secret: true,
        }),
      ),
    status: async (directory: string, attempt: string, signal: AbortSignal) =>
      state(
        await request(`/provider/antigravity-acp/auth/${encodeURIComponent(id(attempt))}`, {
          directory,
          secret: true,
          signal,
        }),
      ),
    cancel: async (directory: string, attempt: string) =>
      state(
        await request(`/provider/antigravity-acp/auth/${encodeURIComponent(id(attempt))}`, {
          method: "DELETE",
          directory,
          secret: true,
        }),
      ),
    complete: () => complete(request),
  }
}

function state(value: unknown): AcpLoginState {
  const item = record(value)
  if (!["starting", "waiting", "authenticated", "error", "cancelled"].includes(String(item.status)))
    invalid("ACP sign-in status")
  // The shared controller validates the URL after learning the ID, so it can cancel a bad response.
  const url = item.url === undefined ? undefined : text(item.url, "ACP sign-in URL", 8192)
  return {
    id: id(text(item.id, "ACP attempt ID", 64)),
    status: item.status as AcpLoginState["status"],
    ...(url ? { url } : {}),
    ...(item.message === undefined ? {} : { message: text(item.message, "ACP error", 2048) }),
  }
}

async function complete(request: ProviderRequest) {
  const config = record(await request("/global/config", { secret: true }))
  const disabled =
    config.disabled_providers === undefined ? [] : array(config.disabled_providers, 1024).map((value) => id(value))
  if (disabled.includes("antigravity-acp"))
    await request("/global/config", {
      method: "PATCH",
      body: { disabled_providers: disabled.filter((value) => value !== "antigravity-acp") },
      secret: true,
      discard: true,
    })
  if ((await request("/global/dispose", { method: "POST" })) !== true) invalid("ACP provider refresh")
}
