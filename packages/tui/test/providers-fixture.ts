import { createProviders } from "../src/providers"
import { cleanup } from "./support"

export function fixture(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 30, fetch })
  const controller = new AbortController()
  cleanup.push(() => server.stop(true))
  cleanup.push(() => controller.abort())
  const headers = new Headers({ Authorization: "Bearer fixture-server-credential" })
  return {
    server,
    controller,
    providers: createProviders({ url: server.url, headers, signal: controller.signal }),
  }
}

export function catalog() {
  return {
    all: [
      {
        id: "openai",
        name: "OpenAI",
        key: "must-not-retain-provider-key",
        options: { apiKey: "must-not-retain-option-key", headers: { Authorization: "must-not-retain-header" } },
        models: {
          "org/model:v1": {
            id: "org/model:v1",
            providerID: "openai",
            name: "Model One",
            headers: { Authorization: "must-not-retain-model-header" },
            options: { apiKey: "must-not-retain-model-key" },
          },
        },
      },
      {
        id: "offline",
        name: "Disconnected",
        models: { hidden: { id: "hidden", providerID: "offline", name: "Unavailable" } },
      },
    ],
    connected: ["openai"],
    default: { openai: "org/model:v1" },
  }
}

export const custom = {
  providerID: "my-gateway",
  name: "My Gateway",
  baseURL: "https://gateway.example.test/v1",
  modelID: "org/model:v1",
  modelName: "My Model",
}

