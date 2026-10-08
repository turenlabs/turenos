import { teammateHandle } from "@turenlabs/client/team"
import {
  array,
  checkDirectory,
  choice,
  clip,
  identifier,
  invalid,
  modelRef,
  name,
  numeric,
  object,
  optional,
  string,
} from "./primitives"


export const factoryStatuses = ["running", "succeeded", "needs_input", "failed", "cancelled", "stale"]

export function integer(value: unknown) {
  if (!Number.isSafeInteger(numeric(value)) || (value as number) < 0) invalid("number")
}

export function room(item: Record<string, unknown>) {
  identifier(item.id, "trm_")
  string(item.name, 512)
  string(item.topic, 4096)
  integer(item.head)
  optional(item.archived, (flag) => typeof flag === "boolean" || invalid("archived"))
  optional(item.factory, (value) => {
    const factory = object(value)
    factoryConfig(object(factory.config))
    integer(factory.revision)
  })
}

function factoryConfig(config: Record<string, unknown>) {
  string(config.outcome, 4000)
  string(config.constraints, 8000)
  string(config.acceptanceCriteria, 4000)
  string(config.directory, 4096)
  string(config.coordinatorTeammateID, 256)
  for (const id of array(config.teammateIDs, 10)) string(id, 256)
  const parameters = object(config.parameters)
  if (Object.keys(parameters).length > 256 || JSON.stringify(parameters).length > 64_000) invalid("parameters")
}

/** `roomID` is the room the answer must belong to; the write routes answer for a room the client may not hold yet. */
export function teammate(item: Record<string, unknown>, roomID?: unknown) {
  identifier(item.id)
  identifier(item.roomID, "trm_")
  if (roomID !== undefined && item.roomID !== roomID) invalid("teammate identity")
  // The server's edit route bounds neither name nor role, so they are checked for content and then cut, not rejected.
  name(item.name, 1024 * 1024)
  clip(item, "name", 512)
  if (typeof item.handle !== "string" || !teammateHandle.test(item.handle)) invalid("handle")
  clip(item, "role", 512)
  clip(item, "mission", 100_000)
  choice(item.status, ["active", "paused"])
  checkDirectory(item.directory)
  optional(item.agent, name)
  optional(item.model, modelRef)
  const time = object(item.time)
  // The coordinator rule orders by creation time.
  numeric(time.created)
  numeric(time.updated)
}

export function duty(item: Record<string, unknown>) {
  identifier(item.loopID)
  identifier(item.teammateID)
}

export function factoryRun(item: Record<string, unknown>) {
  identifier(item.id)
  identifier(item.roomID, "trm_")
  choice(item.status, factoryStatuses)
  choice(item.phase, ["plan", "work", "check", "done"])
  for (const id of array(item.taskIDs, 256)) identifier(id)
  optional(item.result, () => clip(item, "result", 32_768))
  optional(item.error, (text) => string(text, 8000))
  const time = object(item.time)
  numeric(time.created)
  numeric(time.updated)
}
