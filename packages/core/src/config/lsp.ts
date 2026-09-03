export * as ConfigLSP from "./lsp"

import { Schema } from "effect"
import { ConfigBuiltinToggle } from "./builtin-toggle"
import { builtinServerIds } from "../v1/config/lsp"

export const Entry = ConfigBuiltinToggle.Entry
export const Info = ConfigBuiltinToggle.make(builtinServerIds, "ConfigV2.LSP")
