import { CliError } from "../tui-auth"

/** A server origin: http(s), no credentials, path prefix, query or fragment. */
export function origin(address: string) {
  const url = address.length <= 8192 ? URL.parse(address) : null
  if (!url || !/^https?:\/\//i.test(address) || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new CliError({
      message: "The server URL must be a valid http:// or https:// origin (at most 8192 characters).",
    })
  }
  if (url.username || url.password || address.includes("@")) {
    throw new CliError({ message: "Use --username and FORGE_SERVER_PASSWORD for server authentication." })
  }
  // Check the original text too: URL parsing erases empty delimiters, whitespace, and dot segments.
  if (address.includes("?") || address.includes("#")) {
    throw new CliError({ message: "The server URL must not include a query string or fragment." })
  }
  if (
    url.pathname !== "/" ||
    address.trim() !== address ||
    !/^https?:\/\/[^/\\\s\u0000-\u001f\u007f]+\/?$/i.test(address)
  ) {
    throw new CliError({ message: "Use the server's origin URL without a path prefix." })
  }
  return url
}

export function checkUsername(username: string | undefined) {
  if (
    !username ||
    username.length > 512 ||
    username.includes(":") ||
    /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/.test(username)
  ) {
    throw new CliError({ message: "Use a valid username without ':' or control characters (at most 512 characters)." })
  }
  return username
}
