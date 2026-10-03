import { agents, commands, files, terminals } from "./catalog"
import { automations } from "./automation"
import { memories, savedPermissions } from "./memory"
import { invalid, location } from "./primitives"
import { isSessionPatch, validateSessionPatch } from "./session-patch"
import { sessionRoute } from "./session-routes"

export function validateResponse(address: URL, init: RequestInit | undefined, value: unknown) {
  if (isSessionPatch(address, init)) return validateSessionPatch(address, init, value)
  if (!address.pathname.includes("/api/")) invalid("route")
  const route = apiRoute(address)
  const get = (init?.method ?? "GET") === "GET"
  // Routes that skip oversized or unusable items return the sanitized body.
  if (route[0] === "command") return commands(address, value)
  if (route[0] === "session") return sessionRoute(route, init, value)
  if (route[0] === "pty" && route.length === 1 && get) terminals(address, value)
  else if (route[0] === "location") location(value)
  else if (route[0] === "agent") agents(address, value)
  else if (route[0] === "loop") automations(route, init, value)
  else if (route[0] === "memory" && get) memories(route, value)
  else if (route[0] === "permission" && route[1] === "saved" && get) savedPermissions(value)
  else if (route[0] === "fs") files(value)
  return undefined
}

function apiRoute(address: URL) {
  try {
    return address.pathname
      .slice(address.pathname.lastIndexOf("/api/") + 5)
      .split("/")
      .map(decodeURIComponent)
  } catch {
    return invalid("route")
  }
}
