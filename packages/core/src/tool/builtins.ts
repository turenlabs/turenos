export * as BuiltInTools from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Layer } from "effect"
import { AutomationTool } from "./automation"
import { BashTool } from "./bash"
import { CodeSearchTool } from "./code-search"
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
import { BinaryDiffTools } from "./binary-diff-tools"
import { CodecTools } from "./codec-tools"
import { SourcemapTools } from "./sourcemap-tools"
import { JsonQueryTools } from "./json-query-tools"
import { FuzzyHashTools } from "./fuzzy-hash-tools"
import { CryptoMarkersTools } from "./crypto-markers-tools"
import { PdfInspectTools } from "./pdf-inspect-tools"
import { MinidumpTools } from "./minidump-tools"
import { SquashfsTools } from "./squashfs-tools"
import { CodeSigningTools } from "./code-signing-tools"
import { ApkDexTools } from "./apk-dex-tools"
import { JavaInspectTools } from "./java-inspect-tools"
import { ImageInspectTools } from "./image-inspect-tools"
import { UnicodeAuditTools } from "./unicode-audit-tools"
import { WasmToolkitTools } from "./wasm-toolkit-tools"
import { InstallerInspectTools } from "./installer-inspect-tools"
import { GitInspectTools } from "./git-inspect-tools"
import { FirmwareFormatsTools } from "./firmware-formats-tools"
import { CapaMatchTools } from "./capa-match-tools"
import { MacosArtifactsTools } from "./macos-artifacts-tools"
import { BrowserArtifactsTools } from "./browser-artifacts-tools"
import { SqliteInspectTools } from "./sqlite-inspect-tools"
import { RtfInspectTools } from "./rtf-inspect-tools"
import { CarveEmbeddedTool } from "./carve-embedded"
import { DebugSymbolsTools } from "./debug-symbols-tools"
import { LobbyRoomContextTool } from "./lobby-room-context"
import { FollowStream } from "./follow-stream"
import { WhiteboardTool } from "./whiteboard"
import { SecurityProxyTool } from "./security-proxy"

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
    CodeSearchTool.node,
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
  FollowStream.node,
  WhiteboardTool.node,
  SecurityProxyTool.node,
    ForensicTools.node,
    RosettaExecTool.node,
    WasmInspectTools.node,
    BinwalkScanTools.node,
    BinaryDiffTools.node,
    CodecTools.node,
    SourcemapTools.node,
    JsonQueryTools.node,
    FuzzyHashTools.node,
    CryptoMarkersTools.node,
    PdfInspectTools.node,
    MinidumpTools.node,
    SquashfsTools.node,
    CodeSigningTools.node,
    ApkDexTools.node,
    JavaInspectTools.node,
    ImageInspectTools.node,
    UnicodeAuditTools.node,
    WasmToolkitTools.node,
    InstallerInspectTools.node,
    GitInspectTools.node,
    FirmwareFormatsTools.node,
    CapaMatchTools.node,
    MacosArtifactsTools.node,
    BrowserArtifactsTools.node,
    SqliteInspectTools.node,
    RtfInspectTools.node,
    CarveEmbeddedTool.node,
    DebugSymbolsTools.node,
    LobbyRoomContextTool.node,
  ],
})
