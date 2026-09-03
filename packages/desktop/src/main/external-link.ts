const MAX_EXTERNAL_URL_LENGTH = 4096

export function externalHttpUrl(input: unknown) {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_EXTERNAL_URL_LENGTH) return

  const url = URL.parse(input)
  if (!url) return
  if (url.protocol !== "http:" && url.protocol !== "https:") return
  if (url.username || url.password) return
  return url.href
}
