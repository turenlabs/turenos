import { AgentV2 } from "@turenlabs/core/agent"
import { AISDK } from "@turenlabs/core/aisdk"
import { Catalog } from "@turenlabs/core/catalog"
import { CommandV2 } from "@turenlabs/core/command"
import { Credential } from "@turenlabs/core/credential"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNodePlatform } from "@turenlabs/core/effect/app-node-platform"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { FileSystem } from "@turenlabs/core/filesystem"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Global } from "@turenlabs/core/global"
import { Integration } from "@turenlabs/core/integration"
import { Location } from "@turenlabs/core/location"
import { Npm } from "@turenlabs/core/npm"
import { PluginV2 } from "@turenlabs/core/plugin"
import { Reference } from "@turenlabs/core/reference"
import { AbsolutePath } from "@turenlabs/schema/schema"
import { SkillV2 } from "@turenlabs/core/skill"
import { ToolInterceptor } from "@turenlabs/core/tool/interceptor"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Global.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
    ToolInterceptor.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)
