import { Effect, Layer, LayerMap } from "effect"
import { AgentV2 } from "./agent"
import { AgentImprovement } from "./agent/improvement"
import { AgentGuidance } from "./agent/guidance"
import { AISDK } from "./aisdk"
import { Catalog } from "./catalog"
import { CommandV2 } from "./command"
import { Config } from "./config"
import { LayerNode } from "./effect/layer-node"
import { Node } from "./effect/app-node"
import { FileMutation } from "./file-mutation"
import { FileSystem } from "./filesystem"
import { FileSystemSearch } from "./filesystem/search"
import { Watcher } from "./filesystem/watcher"
import { Image } from "./image"
import { Integration } from "./integration"
import { Location } from "./location"
import { LocationMutation } from "./location-mutation"
import { LocationServiceMap } from "./location-service-map"
import { PermissionV2 } from "./permission"
import { PluginV2 } from "./plugin"
import { PluginInternal } from "./plugin/internal"
import { Policy } from "./policy"
import { ProjectCopy } from "./project/copy"
import { Pty } from "./pty"
import { QuestionV2 } from "./question"
import { Reference } from "./reference"
import { ReferenceGuidance } from "./reference/guidance"
import * as SessionRunnerLLM from "./session/runner/llm"
import { SessionRunnerModel } from "./session/runner/model"
import { SessionCommand } from "./session/command"
import { SessionHarness } from "./session/harness"
import { SessionShell } from "./session/shell"
import { SessionTerminal } from "./session/terminal"
import { SessionTodo } from "./session/todo"
import { SkillV2 } from "./skill"
import { SkillGuidance } from "./skill/guidance"
import { Snapshot } from "./snapshot"
import { SystemContextBuiltIns } from "./system-context/builtins"
import { YolkSystemContext } from "./system-context/yolk"
import { SystemContextRegistry } from "./system-context/registry"
import { BuiltInTools } from "./tool/builtins"
import { BatouTool } from "./tool/batou"
import { HandoffTool } from "./tool/handoff"
import { ToolInterceptor } from "./tool/interceptor"
import { McpTool } from "./tool/mcp"
import { ReadToolFileSystem } from "./tool/read-filesystem"
import { ToolRegistry } from "./tool/registry"
import { SessionToolSnapshot } from "./tool/session-snapshot"
import { SubagentTool } from "./tool/subagent"
import { pentestLauncherNode } from "./tool/pentest-launcher"
import { YolkTool } from "./tool/yolk"
import { DecompilerRuntime } from "./tool/decompiler-runtime"
import { YaraRuntime } from "./tool/yara-runtime"
import { EmailSecurityRuntime } from "./tool/email-security-runtime"
import { EmailAuthenticateRuntime } from "./tool/email-authenticate-runtime"
import { BinaryAnalysisRuntime } from "./tool/binary-analysis-runtime"
import { ProtocolInspectRuntime } from "./tool/protocol-inspect-runtime"
import { WasmInspectRuntime } from "./tool/wasm-inspect-runtime"
import { BinwalkScanRuntime } from "./tool/binwalk-scan-runtime"
import { DebugSymbolsRuntime } from "./tool/debug-symbols-runtime"
import { ToolOutputStore } from "./tool-output-store"

export { LocationServiceMap } from "./location-service-map"

export const locationServices = LayerNode.group(
  [
    Location.node,
    Policy.node,
    Config.node,
    AgentV2.node,
    AgentImprovement.node,
    AgentGuidance.node,
    CommandV2.node,
    Reference.node,
    Catalog.node,
    AISDK.node,
    Integration.node,
    PluginV2.node,
    PluginInternal.node,
    ProjectCopy.node,
    ProjectCopy.refreshNode,
    FileSystemSearch.node,
    FileSystem.node,
    Watcher.node,
    Pty.node,
    SkillV2.node,
    SystemContextRegistry.node,
    SystemContextBuiltIns.node,
    YolkSystemContext.node,
    LocationMutation.node,
    FileMutation.node,
    PermissionV2.node,
    ToolOutputStore.node,
    ToolInterceptor.node,
    BatouTool.node,
    YolkTool.node,
    ToolRegistry.node,
    ToolRegistry.toolsNode,
    DecompilerRuntime.node,
    YaraRuntime.node,
    EmailSecurityRuntime.node,
    EmailAuthenticateRuntime.node,
    EmailAuthenticateRuntime.node,
    BinaryAnalysisRuntime.node,
    ProtocolInspectRuntime.node,
    WasmInspectRuntime.node,
    BinwalkScanRuntime.node,
    DebugSymbolsRuntime.node,
    Image.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    SessionCommand.node,
    SessionShell.node,
    SessionTerminal.node,
    SessionTodo.node,
    QuestionV2.node,
    ReadToolFileSystem.node,
    BuiltInTools.node,
    McpTool.node,
    SessionToolSnapshot.node,
    SubagentTool.node,
    pentestLauncherNode,
    HandoffTool.node,
    SessionRunnerModel.node,
    SessionHarness.node,
    Snapshot.node,
    SessionRunnerLLM.node,
  ].filter((node) => node !== undefined),
)

export type LocationServices = LayerNode.Output<typeof locationServices>
export type LocationError = LayerNode.Error<typeof locationServices>

export function buildLocationServiceMap(
  replacements: LayerNode.Replacements = [],
): Layer.Layer<LocationServiceMap.Service> {
  return Layer.effect(
    LocationServiceMap.Service,
    LayerMap.make(
      (ref: Location.Ref) => {
        const allReplacements = replacements.concat([[Location.node, Location.boundNode(ref)]])
        // Apply replacements during hoist, not afterward: replacements can
        // introduce new tagged dependencies (Location.boundNode depends on
        // Project), and the hoist walk is the only pass that can still slice
        // those back out.
        const location = LayerNode.hoist(locationServices, Node.tags.values.global, allReplacements)

        return LayerNode.compile(location.node).pipe(
          Layer.fresh,
          Layer.tap(() =>
            Effect.logInfo("booting location services", {
              directory: ref.directory,
              workspaceID: ref.workspaceID,
            }),
          ),
          Layer.provide(LayerNode.compile(location.hoisted)),
        )
      },
      { idleTimeToLive: "60 minutes" },
    ),
  )
}

// This is temporary for backwards compatibility
export const locationServiceMapLayer = buildLocationServiceMap()
