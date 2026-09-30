import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)

export const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

export function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  // Strip the query off the web Request — fromWeb would carry it into urlParams
  // while setUrl re-adds it to the URL, sending duplicated params downstream.
  return HttpClientRequest.fromWeb(new Request(url.origin + url.pathname, init)).pipe(
    HttpClientRequest.setUrl(url.pathname + url.search),
    HttpClient.execute,
  )
}

export function requestInDirectory(path: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-forge-directory", directory)
  return request(path, { ...init, headers })
}
