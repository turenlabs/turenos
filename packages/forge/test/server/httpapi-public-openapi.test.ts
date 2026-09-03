import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"

type Method = "get" | "post" | "put" | "delete" | "patch"
type OpenApiSchema = {
  readonly $ref?: string
  readonly anyOf?: ReadonlyArray<OpenApiSchema>
  readonly type?: string
  readonly enum?: readonly unknown[]
  readonly properties?: Record<string, OpenApiSchema>
  readonly required?: readonly string[]
  readonly contentSchema?: OpenApiSchema
  readonly contentMediaType?: string
}
type OpenApiResponse = {
  readonly description?: string
  readonly content?: Record<string, { readonly schema?: OpenApiSchema }>
}
type OpenApiOperation = {
  readonly parameters?: ReadonlyArray<{
    readonly name: string
    readonly in: string
    readonly required?: boolean
    readonly schema?: { readonly type?: string }
  }>
  readonly responses?: Record<string, OpenApiResponse>
  readonly requestBody?: { readonly required?: boolean }
  readonly security?: unknown
}
type OpenApiPathItem = Partial<Record<Method, OpenApiOperation>>
type OpenApiSpec = {
  readonly paths: Record<string, OpenApiPathItem>
  readonly components: { readonly schemas: Record<string, OpenApiSchema> }
}

const methods = ["get", "post", "put", "delete", "patch"] as const

const allowedV2BuiltInEndpointErrors: string[] = []

function v2Operations(spec: OpenApiSpec) {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    path.startsWith("/api/")
      ? methods.flatMap((method) => {
          const operation = item[method]
          return operation ? [{ method, path, operation }] : []
        })
      : [],
  )
}

function responseRef(response: OpenApiResponse | undefined) {
  return response?.content?.["application/json"]?.schema?.$ref
}

function componentName(ref: string) {
  return ref.replace("#/components/schemas/", "")
}

function componentNames(response: OpenApiResponse | undefined) {
  const schema = response?.content?.["application/json"]?.schema
  if (!schema) return []
  return [
    ...new Set([schema, ...(schema.anyOf ?? [])].flatMap((item) => (item.$ref ? [componentName(item.$ref)] : []))),
  ]
}

function isBuiltInEndpointError(name: string) {
  return name.startsWith("EffectHttpApiError") || name.startsWith("effect_HttpApiError_")
}

describe("PublicApi OpenAPI v2 errors", () => {
  test("publishes Extension management alongside the integration schemas plugins are typed against", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    expect(spec.paths["/extension"]?.get).toBeDefined()
    expect(spec.paths["/extension/{id}"]?.patch).toBeDefined()
    // Providers are configured through Integration/Credential, not Extension, and
    // `@turenlabs/plugin/v2/*/integration` is typed off these generated schemas, so
    // they have to stay published even though Extension itself never references them.
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining(["CredentialValue", "IntegrationInputs", "IntegrationMethod", "IntegrationRef"]),
    )
  })

  test("documents nested legacy global sync events", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    const schema = spec.components.schemas.SyncEventSessionCreated

    expect(schema?.required).toEqual(["type", "id", "syncEvent"])
    expect(schema?.properties?.type?.enum).toEqual(["sync"])
    expect(schema?.properties?.syncEvent).toMatchObject({
      required: ["type", "id", "seq", "aggregateID", "data"],
      properties: {
        type: { enum: ["session.created.1"] },
        id: { type: "string" },
        seq: { type: "number" },
        aggregateID: { type: "string" },
      },
    })
  })

  test("preserves genuine Storage and goal nullability for generated clients", () => {
    const schemas = (OpenApi.fromApi(PublicApi) as OpenApiSpec).components.schemas
    const nullable = (schema: OpenApiSchema | undefined) => schema?.anyOf?.some((item) => item.type === "null")

    expect(nullable(schemas.StorageGetResult?.properties?.state)).toBe(true)
    expect(nullable(schemas.StorageSetInput?.properties?.expectedRevision)).toBe(true)
    expect(nullable(schemas.StorageRevisionConflictError?.properties?.expected)).toBe(true)
    expect(nullable(schemas.StorageRevisionConflictError?.properties?.actual)).toBe(true)
    expect(nullable(schemas.StorageReceiptResult?.properties?.receipt)).toBe(true)
    expect(nullable(schemas.StorageMigrationReceipt?.properties?.sourceFingerprint)).toBe(true)
    expect(nullable(schemas.StorageMigrationReceipt?.properties?.sourceVersion)).toBe(true)
    expect(nullable(schemas.StorageMigrationReceipt?.properties?.rowCount)).toBe(true)
    expect(nullable(schemas.StorageMigrationReceipt?.properties?.timeVerified)).toBe(true)
    expect(nullable(schemas.SessionGoalGetResponse?.properties?.data)).toBe(true)
  })

  test("declares transcript adoption failures on every mutating goal endpoint", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const [method, path] of [
      ["put", "/api/session/{sessionID}/goal"],
      ["patch", "/api/session/{sessionID}/goal"],
      ["post", "/api/session/{sessionID}/goal/status"],
      ["delete", "/api/session/{sessionID}/goal"],
    ] as const) {
      expect(
        componentNames(spec.paths[path]?.[method]?.responses?.["400"]),
        `${method.toUpperCase()} ${path}`,
      ).toContain("InvalidRequestError")
    }
  })

  test("publishes the durable subagent task lifecycle", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    expect(spec.paths["/api/session/{sessionID}/task"]?.get?.responses?.["200"]).toBeDefined()
    expect(spec.paths["/api/session/{sessionID}/task/{taskID}"]?.get?.responses?.["200"]).toBeDefined()
    expect(spec.paths["/api/session/{sessionID}/task/{taskID}/cancel"]?.post?.responses?.["200"]).toBeDefined()
    expect(spec.paths["/api/session/{sessionID}/task/{taskID}/cancel"]?.post?.responses?.["409"]).toBeDefined()
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining([
        "SessionTaskInfo",
        "SessionTaskOperation",
        "SessionTaskSummary",
        "SessionTaskDetail",
        "SessionTaskListResponse",
        "SessionTaskGetResponse",
        "SessionTaskCancelPayload",
      ]),
    )
  })

  test("names the v2 event union without the SSE string wrapper collision", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    expect(spec.components.schemas.V2Event1).toBeUndefined()
    expect(spec.components.schemas.V2Event?.anyOf?.length).toBeGreaterThan(0)
    expect(spec.components.schemas.V2EventStream).toMatchObject({
      type: "string",
      contentMediaType: "application/json",
      contentSchema: { $ref: "#/components/schemas/V2Event" },
    })
    expect(spec.paths["/api/event"]?.get?.responses?.["200"]?.content?.["text/event-stream"]?.schema).toEqual({
      $ref: "#/components/schemas/V2Event",
    })
  })

  test("preserves /api auth responses", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of v2Operations(spec)) {
      expect(route.operation.responses?.["401"], `${route.method.toUpperCase()} ${route.path}`).toBeDefined()
      expect(route.operation.security, `${route.method.toUpperCase()} ${route.path}`).toEqual([])
    }
  })

  test("preserves required request bodies for v2 mutations", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const path of [
      "/api/session/{sessionID}/prompt",
      "/api/session/{sessionID}/permission/{requestID}/reply",
      "/api/session/{sessionID}/question/{requestID}/reply",
    ]) {
      expect(spec.paths[path]?.post?.requestBody?.required, path).toBe(true)
    }
  })

  test("does not rewrite /api endpoint errors to legacy error components", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    const refs = v2Operations(spec)
      .flatMap((route) =>
        Object.entries(route.operation.responses ?? {}).flatMap(([status, response]) => {
          const ref = responseRef(response)
          return ref ? [`${route.method.toUpperCase()} ${route.path} ${status} ${componentName(ref)}`] : []
        }),
      )
      .filter((entry) => entry.endsWith(" BadRequestError") || entry.endsWith(" NotFoundError"))

    expect(refs).toEqual([])
  })

  test("new /api endpoint errors cannot use built-in components without an explicit allowlist", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    const builtInEndpointErrors = v2Operations(spec)
      .flatMap((route) =>
        Object.entries(route.operation.responses ?? {}).flatMap(([status, response]) => {
          if (status === "401") return []
          const ref = responseRef(response)
          if (!ref) return []
          const name = componentName(ref)
          return isBuiltInEndpointError(name) ? [`${route.method.toUpperCase()} ${route.path} ${status} ${name}`] : []
        }),
      )
      .sort()

    expect(builtInEndpointErrors).toEqual(allowedV2BuiltInEndpointErrors)
  })

  test("documents v2 session not-found errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["post", "/api/session/{sessionID}/prompt"],
      ["post", "/api/session/{sessionID}/compact"],
      ["post", "/api/session/{sessionID}/wait"],
      ["get", "/api/session/{sessionID}/context"],
      ["get", "/api/session/{sessionID}/message"],
    ] as const) {
      expect(componentNames(spec.paths[route[1]]?.[route[0]]?.responses?.["404"])).toContain("SessionNotFoundError")
    }
  })

  test("documents v2 unfinished session mutation errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["post", "/api/session/{sessionID}/compact"],
      ["post", "/api/session/{sessionID}/wait"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["503"]) ?? "")).toBe(
        "ServiceUnavailableError",
      )
    }
  })

  test("documents v2 session read data errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["get", "/api/session/{sessionID}/context"],
      ["get", "/api/session/{sessionID}/message"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["500"]) ?? "")).toMatch(
        /^UnknownError\d*$/,
      )
    }
  })

  test("documents session busy errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["post", "/session/{sessionID}/shell"],
      ["post", "/session/{sessionID}/revert"],
      ["post", "/session/{sessionID}/unrevert"],
      ["delete", "/session/{sessionID}/message/{messageID}"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["409"]) ?? "")).toBe(
        "SessionBusyError",
      )
    }
  })

  test("documents permission and question not-found errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    expect(
      componentName(responseRef(spec.paths["/permission/{requestID}/reply"]?.post?.responses?.["404"]) ?? ""),
    ).toBe("PermissionNotFoundError")
    for (const route of [
      ["post", "/question/{requestID}/reply"],
      ["post", "/question/{requestID}/reject"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["404"]) ?? "")).toBe(
        "QuestionNotFoundError",
      )
    }
    for (const route of [
      ["post", "/api/session/{sessionID}/question/{requestID}/reply"],
      ["post", "/api/session/{sessionID}/question/{requestID}/reject"],
    ] as const) {
      expect(componentNames(spec.paths[route[1]]?.[route[0]]?.responses?.["404"])).toEqual([
        "QuestionNotFoundError",
        "SessionNotFoundError",
      ])
    }
  })

  test("omits retired reference and raw MCP routes while keeping provider configuration published", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec
    const paths = Object.keys(spec.paths)

    // MCP servers come from the Extension catalog now, and the experimental v2
    // reference/integration/credential groups were retired with it.
    expect(paths.filter((path) => path === "/mcp" || path.startsWith("/mcp/"))).toEqual([])
    expect(paths.filter((path) => path === "/api/integration" || path.startsWith("/api/integration/"))).toEqual([])
    expect(paths.filter((path) => path === "/api/credential" || path.startsWith("/api/credential/"))).toEqual([])
    expect(paths.filter((path) => path === "/api/reference" || path.startsWith("/api/reference/"))).toEqual([])
    expect(paths.filter((path) => path.includes("plugin"))).toEqual([])

    // Providers are configured from Settings, so the credential and OAuth routes the
    // Settings pane drives stay on the public surface.
    expect(paths).toEqual(
      expect.arrayContaining([
        "/auth/{providerID}",
        "/provider",
        "/provider/auth",
        "/provider/{providerID}/oauth/authorize",
        "/provider/{providerID}/oauth/callback",
        "/config/providers",
      ]),
    )
  })

  test("documents PTY resource and ticket errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    for (const route of [
      ["get", "/pty/{ptyID}"],
      ["put", "/pty/{ptyID}"],
      ["delete", "/pty/{ptyID}"],
      ["post", "/pty/{ptyID}/connect-token"],
    ] as const) {
      expect(componentName(responseRef(spec.paths[route[1]]?.[route[0]]?.responses?.["404"]) ?? "")).toBe(
        "PtyNotFoundError",
      )
    }
    expect(componentName(responseRef(spec.paths["/pty/{ptyID}/connect-token"]?.post?.responses?.["403"]) ?? "")).toBe(
      "PtyForbiddenError",
    )
    expect(
      spec.paths["/pty/{ptyID}/connect"]?.get?.parameters
        ?.filter((parameter) => parameter.in === "query")
        .map((parameter) => parameter.name),
    ).toEqual(["directory", "workspace", "cursor", "ticket"])
  })

  test("documents project not-found errors", () => {
    const spec = OpenApi.fromApi(PublicApi) as OpenApiSpec

    expect(componentName(responseRef(spec.paths["/project/{projectID}"]?.patch?.responses?.["404"]) ?? "")).toBe(
      "ProjectNotFoundError",
    )
  })
})
