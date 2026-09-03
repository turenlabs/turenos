export * as ConfigLSPV1 from "./lsp"

import { Schema } from "effect"
import { ConfigBuiltinToggle } from "../../config/builtin-toggle"

export const Entry = ConfigBuiltinToggle.Entry

// Keep this list aligned with the builtin servers in opencode's LSP runtime.
// Custom servers must declare extensions because the runtime cannot infer them.
export const builtinServerIds = [
  "deno",
  "typescript",
  "vue",
  "eslint",
  "oxlint",
  "biome",
  "gopls",
  "ruby-lsp",
  "ty",
  "pyright",
  "elixir-ls",
  "zls",
  "csharp",
  "razor",
  "fsharp",
  "sourcekit-lsp",
  "rust",
  "clangd",
  "svelte",
  "astro",
  "jdtls",
  "kotlin-ls",
  "yaml-ls",
  "lua-ls",
  "php intelephense",
  "prisma",
  "dart",
  "ocaml-lsp",
  "bash",
  "terraform",
  "texlab",
  "dockerfile",
  "gleam",
  "clojure-lsp",
  "nixd",
  "tinymist",
  "haskell-language-server",
  "julials",
] as const

export const Info = ConfigBuiltinToggle.make(builtinServerIds, "LspConfig")

export type Info = Schema.Schema.Type<typeof Info>
