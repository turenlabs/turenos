export { EGraph, NodeLimitError, createEGraph, mustRewrite, parsePattern, sortedSet } from "./yolk/egraph"
export type {
  ClassAnalysis,
  EClass,
  ENode,
  Extracted,
  ID,
  Pattern,
  Rewrite,
  RunnerLimits,
  RunnerReport,
  Subst,
} from "./yolk/egraph"
export {
  Language,
  LexerError,
  MAX_SOURCE_FILE_BYTES,
  TokenKind,
  detectLanguage,
  findMatching,
  languageNames,
  languagePrefix,
  isKnownUnsupportedSourcePath,
  lex,
  lexLanguage,
  pathModule,
  shouldSkipIndexDir,
  shouldSkipIndexDirectory,
  shouldSkipIndexFile,
  shouldSkipIndexPath,
  skipNewlines,
  supportedLanguages,
  tokenTexts,
} from "./yolk/language"
export type { LanguageSupport, Token } from "./yolk/language"
export { CodeIndex, IndexCache, buildIndex, parseGoUnit, parseJavaUnit } from "./yolk/indexer"
export type {
  BuildIndexOptions,
  FileUnit,
  FunctionDecl,
  FunctionInfo,
  ImpactNode,
  IndexDiagnostic,
  IndexStats,
} from "./yolk/indexer"
export { EQUIVALENCE_PROFILE, VERSION, buildImpactReport, compareIndexes } from "./yolk/report"
export type {
  AgentChangeSummary,
  AgentImpact,
  CompareReport,
  EquivalenceWitness,
  FunctionChange,
  ImpactReport,
} from "./yolk/report"
export { createYolkRuntime, formatSemanticDiff, hasYolkChanges } from "./yolk/runtime"
export type {
  BatchInspectReport,
  Build,
  InspectInput,
  InspectOutput,
  SymbolCandidate,
  SymbolLookupReport,
} from "./yolk/runtime"
export { discoverPathSymbols, discoverPathSymbolsDetailed } from "./yolk/symbol-table"
export type { SymbolDiscoveryResult } from "./yolk/symbol-table"
