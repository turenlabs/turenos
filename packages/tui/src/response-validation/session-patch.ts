import { parseResponse } from "./parse"
import { checkDirectory, identifier, invalid, name, numeric, object, owner, string } from "./primitives"

export function isSessionPatch(address: URL, init: RequestInit | undefined) {
  return init?.method === "PATCH" && /^\/session\/[^/]+$/.test(address.pathname)
}

/** The legacy session mutation route answers with the whole old-format session. */
export function validateSessionPatch(address: URL, init: RequestInit | undefined, value: unknown) {
  const id = identifier(decodeURIComponent(address.pathname.slice(9)), "ses_")
  const directory = address.searchParams.get("directory")
  checkDirectory(directory)
  const item = object(value)
  owner(item.id, id)
  checkDirectory(item.directory)
  if (item.directory !== directory) invalid("session directory identity")
  string(item.title, 64000)
  const time = object(item.time)
  numeric(time.created)
  numeric(time.updated)
  if (Object.hasOwn(time, "archived")) numeric(time.archived)
  const submitted = object(parseResponse(string(init?.body, 4096)))
  if (Object.keys(submitted).length !== 1) invalid("session mutation")
  if (Object.hasOwn(submitted, "title")) {
    const title = name(string(submitted.title, 200))
    if (!title.trim() || item.title !== title) invalid("session title mutation")
  } else {
    const change = object(submitted.time)
    if (Object.keys(change).length !== 1 || !Object.hasOwn(change, "archived")) invalid("session mutation")
    if (change.archived === null) {
      if (Object.hasOwn(time, "archived")) invalid("session archive mutation")
    } else if (numeric(change.archived) !== time.archived) invalid("session archive mutation")
  }
  // Discard legacy metadata rather than exposing it as a current Session.
  return { id }
}
