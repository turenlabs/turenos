import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { EventV2 } from "@turenlabs/core/event"
import { EventManifest } from "@/event-manifest"
import { Connection } from "@turenlabs/schema/connection"
import { Credential } from "@turenlabs/core/credential"
import { Integration } from "@turenlabs/core/integration"
import { InstanceDisposed } from "@/server/event"
import { Question } from "@/question"
import { ConfigApi } from "./groups/config"
import { ControlApi } from "./groups/control"
import { ControlPlaneApi } from "./groups/control-plane"
import { EventApi } from "./groups/event"
import { ExperimentalApi } from "./groups/experimental"
import { ExtensionApi } from "./groups/extension"
import { FileApi } from "./groups/file"
import { InstanceApi } from "./groups/instance"
import { PermissionApi } from "./groups/permission"
import { ProjectApi } from "./groups/project"
import { ProjectCopyApi } from "./groups/project-copy"
import { ProviderApi } from "./groups/provider"
import { PtyApi, PtyConnectApi } from "./groups/pty"
import { QuestionApi } from "./groups/question"
import { SecurityApi } from "./groups/security"
import { PentestApi } from "./groups/pentest"
import { StorageApi } from "./groups/storage"
import { SessionApi } from "./groups/session"
import { SyncApi } from "./groups/sync"
import { WorkspaceApi } from "./groups/workspace"
import { makeApi } from "@turenlabs/protocol/api"
import { LocationMiddleware } from "@turenlabs/server/location"
import { SessionLocationMiddleware } from "@turenlabs/server/middleware/session-location"
import { GlobalApi } from "./groups/global"
import { Authorization } from "./middleware/authorization"
import { SchemaErrorMiddleware } from "./middleware/schema-error"

const EventSchema = Schema.Union([
  ...EventManifest.Latest.values()
    .map((definition) =>
      Schema.Struct({
        id: EventV2.ID,
        type: Schema.Literal(definition.type),
        properties: definition.data,
      }).annotate({ identifier: `Event.${definition.type}` }),
    )
    .toArray(),
  InstanceDisposed,
]).annotate({ identifier: "Event" })

export const ServerApi = makeApi({
  definitions: EventManifest.Latest.values().toArray(),
  locationMiddleware: LocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
})

export const RootHttpApi = HttpApi.make("forge-root")
  .addHttpApi(ControlApi)
  .addHttpApi(ControlPlaneApi)
  .addHttpApi(GlobalApi)
  .addHttpApi(SecurityApi)
  .addHttpApi(StorageApi)
  .middleware(SchemaErrorMiddleware)
  .middleware(Authorization)

export const InstanceHttpApi = HttpApi.make("forge-instance")
  .addHttpApi(ConfigApi)
  .addHttpApi(ExperimentalApi)
  .addHttpApi(ExtensionApi)
  .addHttpApi(FileApi)
  .addHttpApi(InstanceApi)
  .addHttpApi(ProjectApi)
  .addHttpApi(ProjectCopyApi)
  .addHttpApi(PtyApi)
  .addHttpApi(QuestionApi)
  .addHttpApi(PermissionApi)
  .addHttpApi(ProviderApi)
  .addHttpApi(SessionApi)
  .addHttpApi(SyncApi)
  .addHttpApi(WorkspaceApi)
  .middleware(SchemaErrorMiddleware)

export const ForgeHttpApi = HttpApi.make("forge")
  .addHttpApi(RootHttpApi)
  .addHttpApi(PentestApi)
  .addHttpApi(EventApi)
  .addHttpApi(InstanceHttpApi)
  .addHttpApi(ServerApi)
  .addHttpApi(PtyConnectApi)
  .annotate(HttpApi.AdditionalSchemas, [
    EventSchema,
    Question.Replied,
    Question.Rejected,
    Connection.Info,
    Credential.Value,
    Integration.Inputs,
    Integration.Method,
    Integration.Ref,
  ])

export type RootHttpApiType = typeof RootHttpApi
export type InstanceHttpApiType = typeof InstanceHttpApi
