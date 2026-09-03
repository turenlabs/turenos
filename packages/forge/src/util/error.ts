import { isRecord } from "./record"

type ConfigIssue = { message: string; path: string[] }

export function cliErrorMessage(input: unknown): string | undefined {
  if (input instanceof Error && isRecord(input.cause) && "body" in input.cause) {
    const formatted = cliErrorMessage(input.cause.body)
    if (formatted) return formatted
  }

  if (tagged(input, "CliError")) {
    if (typeof input.exitCode === "number") process.exitCode = input.exitCode
    return field(input, "message") ?? ""
  }
  if (tagged(input, "AccountServiceError") || tagged(input, "AccountTransportError")) {
    return field(input, "message") ?? ""
  }

  const model = configData(input, "ProviderModelNotFoundError")
  if (model) {
    const suggestions = Array.isArray(model.suggestions)
      ? model.suggestions.filter((item): item is string => typeof item === "string")
      : []
    return [
      `Model not found: ${field(model, "providerID")}/${field(model, "modelID")}`,
      ...(suggestions.length ? ["Did you mean: " + suggestions.join(", ")] : []),
      "Try: `forge models` to list available models",
      "Or check your config (forge.json) provider/model names",
    ].join("\n")
  }

  const provider = configData(input, "ProviderInitError")
  if (provider) {
    return `Failed to initialize provider "${field(provider, "providerID")}". Check credentials and configuration.`
  }

  const config = configErrorMessage(input)
  if (config !== undefined) return config

  if (tagged(input, "UICancelledError") || named(input, "UICancelledError")) return ""
  if (isRecord(input) && named(input, "MCPFailed")) {
    const name = isRecord(input.data) ? field(input.data, "name") : undefined
    return `MCP server "${name}" failed. Note, forge does not support MCP authentication yet.`
  }
}

/**
 * Spells out a config error's structured data, or `undefined` when the input is not one.
 *
 * Split out of {@link cliErrorMessage} so callers that are not a CLI can use it: `cliErrorMessage`
 * sets `process.exitCode` when it recognises a `CliError`, which a server request handler must never
 * do. Everything here is side-effect free.
 *
 * `NamedError` passes its *name* to `Error`, so `.message` on any of these is just the error's own
 * name -- "ConfigInvalidError" and nothing else. Reading `.data` is the only way to learn which file
 * and which key were at fault, which is what makes the difference between an unactionable string and
 * a message a user can fix.
 */
export function configErrorMessage(input: unknown): string | undefined {
  const json = configData(input, "ConfigJsonError")
  if (json) {
    const message = field(json, "message")
    return `Config file at ${field(json, "path")} is not valid JSON(C)` + (message ? `: ${message}` : "")
  }

  const directory = configData(input, "ConfigDirectoryTypoError")
  if (directory) {
    return `Directory "${field(directory, "dir")}" in ${field(directory, "path")} is not valid. Rename the directory to "${field(directory, "suggestion")}" or remove it. This is a common typo.`
  }

  const frontmatter = configData(input, "ConfigFrontmatterError")
  if (frontmatter) return field(frontmatter, "message") ?? ""

  const invalid = configData(input, "ConfigInvalidError")
  if (invalid) {
    const path = field(invalid, "path")
    const message = field(invalid, "message")
    const issues = Array.isArray(invalid.issues)
      ? invalid.issues.filter((issue): issue is ConfigIssue => {
          return (
            isRecord(issue) &&
            typeof issue.message === "string" &&
            Array.isArray(issue.path) &&
            issue.path.every((item) => typeof item === "string")
          )
        })
      : []
    return [
      `Configuration is invalid${path && path !== "config" ? ` at ${path}` : ""}` + (message ? `: ${message}` : ""),
      // The path is empty for a whole-document issue such as an unrecognized root key; appending it
      // unconditionally left a trailing space on the one message users see most.
      ...issues.map((issue) =>
        issue.path.length ? `↳ ${issue.message} ${issue.path.join(".")}` : `↳ ${issue.message}`,
      ),
    ].join("\n")
  }

  return undefined
}

function tagged(input: unknown, tag: string): input is Record<string, unknown> {
  return isRecord(input) && input._tag === tag
}

function named(input: unknown, name: string) {
  return isRecord(input) && (input.name === name || input._tag === name)
}

function configData(input: unknown, tag: string) {
  if (!isRecord(input)) return
  if (input.name === tag && isRecord(input.data)) return input.data
  if (input._tag === tag) return input
}

function field(input: Record<string, unknown>, key: string) {
  return typeof input[key] === "string" ? input[key] : undefined
}

export function errorFormat(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  if (typeof error === "object" && error !== null) {
    try {
      const json = JSON.stringify(error, null, 2)
      if (json !== "{}") return json
      const text = String(error)
      if (text && text !== "[object Object]") return text
      const constructor = error.constructor?.name
      const prefix = constructor && constructor !== "Object" ? constructor : "Error"
      const names = Object.getOwnPropertyNames(error)
      return names.length === 0 ? `${prefix} (no message)` : `${prefix} { ${names.join(", ")} }`
    } catch {
      return "Unexpected error (unserializable)"
    }
  }
  return String(error)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message) return error.message
    if (error.name) return error.name
  }
  if (isRecord(error) && typeof error.message === "string" && error.message) return error.message
  if (isRecord(error) && isRecord(error.data) && typeof error.data.message === "string" && error.data.message) {
    return error.data.message
  }
  const text = String(error)
  if (text && text !== "[object Object]") return text
  return errorFormat(error) || "unknown error"
}

export function errorData(error: unknown) {
  if (error instanceof Error) {
    return {
      type: error.name,
      message: errorMessage(error),
      stack: error.stack,
      cause: error.cause === undefined ? undefined : errorFormat(error.cause),
      formatted: errorFormat(error),
    }
  }
  if (!isRecord(error)) {
    return {
      type: typeof error,
      message: errorMessage(error),
      formatted: errorFormat(error),
    }
  }
  const data = Object.getOwnPropertyNames(error).reduce<Record<string, unknown>>((result, key) => {
    const value = error[key]
    if (value === undefined) return result
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value
      return result
    }
    result[key] = value instanceof Error ? value.message : String(value)
    return result
  }, {})
  if (typeof data.message !== "string") data.message = errorMessage(error)
  if (typeof data.type !== "string") data.type = error.constructor?.name
  data.formatted = errorFormat(error)
  return data
}
