import type { ToolExecuteSpec } from "../tool.js"
import type { Hooks } from "./registration.js"

export type {
  ToolExecuteAfter,
  ToolExecuteBefore,
  ToolExecuteDecision,
  ToolExecuteIdentity,
  ToolExecuteResult,
} from "../tool.js"

export interface ToolHooks {
  readonly execute: Hooks<ToolExecuteSpec>
}
