import { Api } from "@turenlabs/server/api"
import { OpenApi } from "effect/unstable/httpapi"

await Bun.write(
  new URL("../test/fixtures/forge-v2-openapi.json", import.meta.url),
  `${JSON.stringify(OpenApi.fromApi(Api), null, 2)}\n`,
)
