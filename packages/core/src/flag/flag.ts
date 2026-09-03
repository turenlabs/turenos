import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["FORGE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["FORGE_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("FORGE_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  FORGE_AUTO_HEAP_SNAPSHOT: truthy("FORGE_AUTO_HEAP_SNAPSHOT"),
  FORGE_GIT_BASH_PATH: process.env["FORGE_GIT_BASH_PATH"],
  FORGE_CONFIG: process.env["FORGE_CONFIG"],
  FORGE_CONFIG_CONTENT: process.env["FORGE_CONFIG_CONTENT"],
  FORGE_DISABLE_AUTOUPDATE: truthy("FORGE_DISABLE_AUTOUPDATE"),
  FORGE_ALWAYS_NOTIFY_UPDATE: truthy("FORGE_ALWAYS_NOTIFY_UPDATE"),
  FORGE_DISABLE_PRUNE: truthy("FORGE_DISABLE_PRUNE"),
  FORGE_DISABLE_TERMINAL_TITLE: truthy("FORGE_DISABLE_TERMINAL_TITLE"),
  FORGE_SHOW_TTFD: truthy("FORGE_SHOW_TTFD"),
  FORGE_DISABLE_AUTOCOMPACT: truthy("FORGE_DISABLE_AUTOCOMPACT"),
  FORGE_DISABLE_MODELS_FETCH: truthy("FORGE_DISABLE_MODELS_FETCH"),
  FORGE_DISABLE_MOUSE: truthy("FORGE_DISABLE_MOUSE"),
  FORGE_FAKE_VCS: process.env["FORGE_FAKE_VCS"],
  FORGE_SERVER_PASSWORD: process.env["FORGE_SERVER_PASSWORD"],
  FORGE_SERVER_USERNAME: process.env["FORGE_SERVER_USERNAME"],
  FORGE_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("FORGE_DISABLE_FFF"),

  // Experimental
  FORGE_EXPERIMENTAL_FILEWATCHER: Config.boolean("FORGE_EXPERIMENTAL_FILEWATCHER").pipe(Config.withDefault(false)),
  FORGE_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("FORGE_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  FORGE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("FORGE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  FORGE_MODELS_URL: process.env["FORGE_MODELS_URL"],
  FORGE_MODELS_PATH: process.env["FORGE_MODELS_PATH"],
  FORGE_DB: process.env["FORGE_DB"],

  FORGE_WORKSPACE_ID: process.env["FORGE_WORKSPACE_ID"],
  FORGE_EXPERIMENTAL_WORKSPACES: enabledByExperimental("FORGE_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get FORGE_DISABLE_PROJECT_CONFIG() {
    return truthy("FORGE_DISABLE_PROJECT_CONFIG")
  },
  get FORGE_DISABLE_CLAUDE_CODE_PROMPT() {
    return truthy("FORGE_DISABLE_CLAUDE_CODE") || truthy("FORGE_DISABLE_CLAUDE_CODE_PROMPT")
  },
  get FORGE_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("FORGE_EXPERIMENTAL_REFERENCES")
  },
  get FORGE_CONFIG_DIR() {
    return process.env["FORGE_CONFIG_DIR"]
  },
  get FORGE_PURE() {
    return truthy("FORGE_PURE")
  },
  get FORGE_PERMISSION() {
    return process.env["FORGE_PERMISSION"]
  },
  get FORGE_PLUGIN_META_FILE() {
    return process.env["FORGE_PLUGIN_META_FILE"]
  },
  get FORGE_CLIENT() {
    return process.env["FORGE_CLIENT"] ?? "cli"
  },
}
