export * as ConfigFormatter from "./formatter"

import { Schema } from "effect"
import { ConfigBuiltinToggle } from "./builtin-toggle"
import { builtinFormatterIds } from "../v1/config/formatter"

export const Entry = ConfigBuiltinToggle.Entry

export const Info = ConfigBuiltinToggle.make(builtinFormatterIds, "ConfigV2.Formatter")
