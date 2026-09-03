export * as ConfigSubagent from "./subagent"

import { SessionTask } from "@turenlabs/schema/session-task"
import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.Subagents")({
  max_concurrent: PositiveInt.pipe(Schema.optional).annotate({
    description: `Subagents one session may run at the same time. Defaults to ${SessionTask.DEFAULT_ACTIVE_PER_ROOT}; values above ${SessionTask.MAX_ACTIVE_PER_ROOT} are clamped.`,
  }),
}) {}
