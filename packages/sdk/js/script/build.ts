#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient, reserved } from "@hey-api/openapi-ts"

// Preserve the existing exported SDK classes; these names are scoped to the SDK
// module and do not shadow the web globals used in the separate transport module.
reserved.runtime.set((names) => names.filter((name) => !["Event", "File", "Request"].includes(name)))

const forge = path.resolve(dir, "../../forge")

await $`bun dev generate > ${dir}/openapi.json`.cwd(forge)

const document = (await Bun.file("./openapi.json").json()) as {
  components?: { schemas?: Record<string, unknown> }
  [key: string]: unknown
}
const schemas = document.components?.schemas
if (schemas) {
  const reachable = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
        const name = child.slice("#/components/schemas/".length)
        if (reachable.has(name)) continue
        reachable.add(name)
        visit(schemas[name])
      } else {
        visit(child)
      }
    }
  }
  visit({ ...document, components: { ...document.components, schemas: undefined } })
  for (const name of Object.keys(schemas)) {
    if (/^SessionNext\w+1$/.test(name) && !reachable.has(name)) delete schemas[name]
  }
  await Bun.write("./openapi.json", JSON.stringify(document))
}

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "ForgeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "ForgeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

const generatedTypes = await Bun.file("./src/v2/gen/types.gen.ts").text()
if (/export type SessionNext\w+1 =/.test(generatedTypes)) {
  throw new Error("Session history generated duplicate Session event variants")
}
const historyTypesPatched = generatedTypes.replace(
  /(export type V2SessionHistoryData = \{[\s\S]*?query\?: \{\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historyTypesPatched === generatedTypes) {
  throw new Error("Session history numeric query patch did not apply")
}
await Bun.write("./src/v2/gen/types.gen.ts", historyTypesPatched)

const generatedSdk = await Bun.file("./src/v2/gen/sdk.gen.ts").text()
const historySdkPatched = generatedSdk.replace(
  /(Get session history[\s\S]*?parameters: \{\s*sessionID: string[;,]\s*limit\?: )string([;,]\s*after\?: )string/,
  "$1number$2number",
)
if (historySdkPatched === generatedSdk) {
  throw new Error("Session history numeric SDK patch did not apply")
}
await Bun.write("./src/v2/gen/sdk.gen.ts", historySdkPatched)

// Upstream now gives SSE iterators a void return slot. Keep the invariant checked
// so a generator upgrade cannot make HTTP errors into iterator return values again.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesSource = await Bun.file(sseTypesPath).text()
if (!sseTypesSource.includes("=> Promise<ServerSentEventsResult<TData>>")) {
  throw new Error(`Unexpected SSE iterator return type (${sseTypesPath})`)
}

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
