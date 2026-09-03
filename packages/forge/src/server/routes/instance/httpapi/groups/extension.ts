import { Extension } from "@turenlabs/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"
import { InvalidRequestError } from "../errors"

const Items = Schema.Array(Extension.Item).annotate({ identifier: "Extension.Items" })
const Params = Schema.Struct({ id: Schema.String })

const ExtensionReadApi = HttpApiGroup.make("extensionRead")
  .add(
    HttpApiEndpoint.get("list", "/extension", {
      query: WorkspaceRoutingQuery,
      success: described(Items, "Extension catalog and runtime status"),
    }).annotateMerge(OpenApi.annotations({ identifier: "extension.list", summary: "List extensions" })),
  )
  .middleware(WorkspaceRoutingMiddleware)
  .middleware(Authorization)

const ExtensionWriteApi = HttpApiGroup.make("extensions")
  .add(
    HttpApiEndpoint.patch("update", "/extension/:id", {
      params: Params,
      query: WorkspaceRoutingQuery,
      payload: Extension.Update,
      success: described(Items, "Extension catalog after update"),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "extension.update", summary: "Enable or disable an extension" }),
    ),
  )
  .middleware(InstanceContextMiddleware)
  .middleware(WorkspaceRoutingMiddleware)
  .middleware(Authorization)

export const ExtensionApi = HttpApi.make("extensions-api").add(ExtensionReadApi).add(ExtensionWriteApi)
