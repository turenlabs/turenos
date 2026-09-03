export * as BuiltInTools from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Layer } from "effect"
import { AutomationTool } from "./automation"
import { BashTool } from "./bash"
import { ApplyPatchTool } from "./apply-patch"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GoalTool } from "./goal"
import { GrepTool } from "./grep"
import { QuestionTool } from "./question"
import { ReadTool } from "./read"
import { SkillTool } from "./skill"
import { TodoWriteTool } from "./todowrite"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { WriteTool } from "./write"
import { MemoryTool } from "./memory"
import { ReflectionTool } from "./reflection"
import { DecompileTool } from "./decompile"
import { HexviewTool } from "./hexview"
import { PentestTool } from "./pentest"
import { YaraTool } from "./yara"
import { EmailSecurityTools } from "./email-security-tools"
import { EmailAuthenticateTools } from "./email-authenticate-tools"
import { BinaryAnalysisTools } from "./binary-analysis-tools"
import { StaticAnalysisTools } from "./static-analysis-tools"
import { ProtocolInspectTools } from "./protocol-inspect-tools"
import { ForensicTools } from "./forensic-tools"
import { RosettaExecTool } from "./rosetta-exec"
import { WasmInspectTools } from "./wasm-inspect-tools"
import { BinwalkScanTools } from "./binwalk-scan-tools"
import { CarveEmbeddedTool } from "./carve-embedded"
import { DebugSymbolsTools } from "./debug-symbols-tools"
import { LobbyRoomContextTool } from "./lobby-room-context"

/**
 * Composes only the shipped Location-scoped built-in tool transforms.
 * Each tool retains its implementation and focused tests independently. Dynamic
 * MCP and plugin tools later use separate scoped canonical registrations, while
 * provider/model filtering belongs to a future materialization phase rather
 * than this static list. The caller intentionally supplies shared Location
 * services once to this merged set.
 *
 * TODO: Port the remaining launch-follow-up leaves deliberately: edit fuzzy
 * parity, task, LSP,
 * repo_clone, repo_overview, plan_exit, and Rune/code mode. Keep MCP and plugin
 * transforms separate from this static built-in list.
 */
export const node = makeLocationNode({
  name: "built-in-tools",
  layer: Layer.empty,
  deps: [
    ApplyPatchTool.node,
    AutomationTool.node,
    BashTool.node,
    EditTool.node,
    GlobTool.node,
    GoalTool.node,
    GrepTool.node,
    QuestionTool.node,
    ReadTool.node,
    SkillTool.node,
    TodoWriteTool.node,
    WebFetchTool.node,
    WebSearchTool.node,
    WriteTool.node,
    MemoryTool.node,
    ReflectionTool.node,
    HexviewTool.node,
    DecompileTool.node,
    YaraTool.node,
    EmailSecurityTools.node,
    EmailAuthenticateTools.node,
    EmailAuthenticateTools.node,
    BinaryAnalysisTools.node,
    StaticAnalysisTools.node,
    ProtocolInspectTools.node,
    ForensicTools.node,
    RosettaExecTool.node,
    WasmInspectTools.node,
    BinwalkScanTools.node,
    CarveEmbeddedTool.node,
    DebugSymbolsTools.node,
    PentestTool.node,
    LobbyRoomContextTool.node,
  ],
})
