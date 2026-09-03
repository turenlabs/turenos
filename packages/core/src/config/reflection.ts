export * as ConfigReflection from "./reflection"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.Reflection")({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable embedded TurenOS reflection checkpoints",
  }),
  every_sessions: PositiveInt.pipe(Schema.optional).annotate({
    description: "Completed root sessions between reflection checkpoints",
  }),
}) {}
