import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@turenlabs/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~forge/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~forge/WorkspaceRef", {
  defaultValue: () => undefined,
})
