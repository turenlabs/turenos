export * as LobbySession from "./lobby-session"

import { Schema } from "effect"
import { Permission } from "./permission"
import { optional } from "./schema"

export const MetadataKey = "forge.lobby"

export const CapabilityProfile = Schema.Literals(["read_only", "workspace", "full"] as const)
export type CapabilityProfile = typeof CapabilityProfile.Type

export const Binding = Schema.Struct({
  baseURL: Schema.String,
  roomID: Schema.String,
  agentMemberID: Schema.String,
  capabilityProfile: CapabilityProfile.pipe(optional),
})
export type Binding = typeof Binding.Type

export function binding(metadata: Readonly<Record<string, unknown>> | undefined) {
  return Schema.decodeUnknownOption(Binding)(metadata?.[MetadataKey])
}

export function capabilityProfile(binding: Binding) {
  return binding.capabilityProfile ?? "workspace"
}

export function capabilityRules(profile: CapabilityProfile): Permission.Ruleset {
  if (profile === "full") return [{ action: "*", resource: "*", effect: "allow" }]
  if (profile === "workspace")
    return [
      { action: "*", resource: "*", effect: "allow" },
      ...[
        "external_directory",
        "handoff_session",
        "automation_create",
        "automation_update",
        "apply_agent_improvement",
        "memory.write",
        "memory.forget",
      ].map((action): Permission.Rule => ({ action, resource: "*", effect: "deny" })),
    ]
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...[
      "lobby_room_context",
      "read",
      "grep",
      "glob",
      "list",
      "webfetch",
      "websearch",
      "lsp",
      "skill",
      "memory.read",
    ].map((action): Permission.Rule => ({ action, resource: "*", effect: "allow" })),
  ]
}
