export * as ConfigFormatterV1 from "./formatter"

import { Schema } from "effect"
import { ConfigBuiltinToggle } from "../../config/builtin-toggle"

export const builtinFormatterIds = [
  "gofmt",
  "mix",
  "prettier",
  "oxfmt",
  "biome",
  "zig",
  "clang-format",
  "ktlint",
  "ruff",
  "air",
  "uv",
  "rubocop",
  "standardrb",
  "htmlbeautifier",
  "dart",
  "ocamlformat",
  "terraform",
  "latexindent",
  "gleam",
  "shfmt",
  "nixfmt",
  "rustfmt",
  "pint",
  "ormolu",
  "cljfmt",
  "dfmt",
] as const

export const Entry = ConfigBuiltinToggle.Entry

export const Info = ConfigBuiltinToggle.make(builtinFormatterIds, "FormatterConfig")
export type Info = Schema.Schema.Type<typeof Info>
