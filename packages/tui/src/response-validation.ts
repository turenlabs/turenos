// The transport's byte limit also applies to unused metadata. A shallow scanner
// rejects pathological JSON nesting before parsing; validators inspect only
// fields consumed by this client, without recursing into arbitrary tool metadata.
export function parseResponse(text: string): unknown {
  let depth = 0
  let containers = 0
  let quoted = false
  let escaped = false
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    if (character === "{" || character === "[") {
      if (++depth > 64 || ++containers > 50000) invalid("JSON complexity limit")
    }
    if (character === "}" || character === "]") {
      depth--
      if (depth < 0) invalid("JSON complexity limit")
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    return invalid("JSON")
  }
}

export function validateResponse(address: URL, init: RequestInit | undefined, value: unknown) {
  if (init?.method === "PATCH" && /^\/session\/[^/]+$/.test(address.pathname)) {
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
    const submitted = object(parseResponse(string(init.body, 4096)))
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
  if (!address.pathname.includes("/api/")) invalid("route")
  let route: string[]
  try {
    route = address.pathname
      .slice(address.pathname.lastIndexOf("/api/") + 5)
      .split("/")
      .map(decodeURIComponent)
  } catch {
    invalid("route")
  }
  if (route[0] === "pty" && route.length === 1 && (init?.method ?? "GET") === "GET") {
    const response = object(value)
    location(response.location)
    const requested = address.searchParams.get("location[directory]")
    if (requested !== null && object(response.location).directory !== requested) invalid("terminal location identity")
    unique(array(response.data, 1000), (value) => {
      const item = object(value)
      identifier(item.id, "pty_")
      string(item.title, 64000)
      string(item.command)
      array(item.args, 256).forEach((arg) => string(arg, 64000))
      checkDirectory(item.cwd)
      choice(item.status, ["running", "exited"])
      if (!Number.isSafeInteger(numeric(item.pid)) || Number(item.pid) < 0) invalid("process ID")
      optional(item.exitCode, numeric)
    })
    return undefined
  }
  if (route[0] === "location") {
    location(value)
    return undefined
  }
  if (route[0] === "agent") {
    const response = object(value)
    location(response.location)
    const requested = address.searchParams.get("location[directory]")
    if (requested !== null && object(response.location).directory !== requested) invalid("agent location identity")
    unique(array(response.data, 256), (value) => {
      const item = object(value)
      name(item.id)
      choice(item.mode, ["primary", "subagent", "all"])
      if (typeof item.hidden !== "boolean") invalid("agent visibility")
      optional(item.description, string)
      optional(item.model, modelRef)
    })
    return undefined
  }
  if (route[0] === "command") {
    const response = object(value)
    location(response.location)
    const resolved = object(response.location)
    const directory = address.searchParams.get("location[directory]")
    const workspace = address.searchParams.get("location[workspace]")
    if (directory !== null && resolved.directory !== directory) invalid("command location identity")
    if (workspace !== null && resolved.workspaceID !== workspace) invalid("command workspace identity")
    const names = new Set<string>()
    for (const value of array(response.data, 256)) {
      const item = object(value)
      const command = name(item.name)
      if (/[\s/\\]/.test(command)) invalid("command name")
      if (names.has(command)) invalid("duplicate command name")
      names.add(command)
      string(item.template, 1024 * 1024)
      if (item.description !== undefined) string(item.description, 64000)
      if (item.agent !== undefined) name(item.agent)
      if (item.model !== undefined) modelRef(item.model)
      if (item.subtask !== undefined && typeof item.subtask !== "boolean") invalid("command subtask")
    }
    return undefined
  }
  if (route[0] === "loop") {
    // Only the automation and run lists are collections; mutations answer with one object that
    // the automation controls check themselves.
    if ((init?.method ?? "GET") !== "GET" || !(route.length === 1 || (route.length === 3 && route[2] === "run")))
      return undefined
    unique(array(value, 1000), (value) => {
      const item = object(value)
      identifier(item.id)
      if (route[2] === "run") {
        if (identifier(item.loopID) !== identifier(route[1])) invalid("automation identity")
        choice(item.status, ["claimed", "running", "succeeded", "failed", "cancelled", "skipped", "stale"])
        return
      }
      name(item.name)
      string(item.prompt)
      location(item.location)
      choice(item.status, ["active", "paused", "expired"])
      const schedule = object(item.schedule)
      choice(schedule.type, ["interval", "cron"])
      if (numeric(schedule.seconds) < 1) invalid("automation interval")
      name(schedule.timezone)
      if (schedule.type === "cron") name(schedule.expression)
      optional(item.nextRunAt, (value) =>
        typeof value === "number" ? numeric(value) : choice(value, ["Infinity", "-Infinity", "NaN"]),
      )
      optional(item.eventTrigger, (value) => {
        if (value === null) return
        const trigger = object(value)
        choice(trigger.type, ["file-change", "session-end"])
        if (trigger.type === "file-change") {
          for (const path of array(trigger.paths, 100)) string(path, 4096)
          optional(trigger.debounceMs, (v) =>
            typeof v === "number" ? numeric(v) : choice(v, ["Infinity", "-Infinity", "NaN"]),
          )
        } else if (trigger.type === "session-end") {
          optional(trigger.outcomes, (v) => array(v, 2).forEach((o) => choice(o, ["success", "failure"])))
          optional(trigger.sessionID, (v) => v !== null && identifier(v, "ses_"))
          optional(trigger.agent, (v) => v !== null && name(v))
        }
      })
    })
    return undefined
  }
  if (route[0] === "memory" && (init?.method ?? "GET") === "GET") {
    for (const entry of array(value, 5000)) {
      const item = object(entry)
      identifier(item.id)
      string(item.name ?? item.title, 4096)
      if (route[1] === "wing") string(item.key, 4096)
      if (route[1] === "room") string(item.slug, 512)
      if (route.length > 1) continue
      choice(item.kind, ["note", "fact", "decision", "observation"])
      string(item.body)
      optional(item.supersededBy, identifier)
      const provenance = object(item.provenance)
      string(provenance.assertedBy, 512)
      string(provenance.source, 32)
      const anchor = object(item.anchor)
      optional(anchor.path, string)
      optional(anchor.symbol, string)
    }
    return undefined
  }
  if (route[0] === "permission" && route[1] === "saved" && (init?.method ?? "GET") === "GET") {
    for (const entry of array(object(value).data, 5000)) {
      const item = object(entry)
      identifier(item.id)
      string(item.action, 512)
      string(item.resource, 64000)
    }
    return undefined
  }
  if (route[0] === "fs") {
    const response = object(value)
    location(response.location)
    for (const entry of array(response.data, 200)) {
      const item = object(entry)
      // Results become `file://` prompt attachments, so an absolute or escaping
      // path would address a file outside the requested location.
      const path = string(item.path, 4096)
      if (!path || /[\u0000-\u001f\u007f-\u009f]/.test(path)) invalid("file path")
      if (path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path)) invalid("file path")
      if (path.split(/[\\/]/).includes("..")) invalid("file path")
      choice(item.type, ["file", "directory"])
    }
    return undefined
  }
  if (route[0] !== "session") return undefined
  const response = object(value)
  if (route[1] === "active") {
    const entries = Object.entries(object(response.data))
    if (entries.length > 128) invalid("more than 128 active sessions")
    for (const [id, item] of entries) {
      identifier(id, "ses_")
      choice(object(item).type, ["running"])
    }
    return undefined
  }
  if (route.length === 1) {
    if (init?.method === "POST") {
      const submitted = object(parseResponse(string(init.body)))
      session(response.data, identifier(submitted.id, "ses_"))
      return undefined
    }
    unique(array(response.data, 100), session)
    cursor(response.cursor)
    return undefined
  }
  if (route[1] === "interrupt-all") {
    const result = object(response.data)
    for (const count of [result.interrupted, result.failed])
      if (!Number.isSafeInteger(numeric(count)) || Number(count) < 0) invalid("interrupt count")
    return undefined
  }
  const sessionID = identifier(route[1], "ses_")
  optional(response.sessionID, (value) => owner(value, sessionID))
  if (route.length === 2) {
    session(response.data, sessionID)
    return undefined
  }
  if (route[2] === "message") {
    unique(array(response.data, 30), (value) => message(value, sessionID))
    cursor(response.cursor)
    return undefined
  }
  if (route[2] === "task") {
    // Only the task inventory is a list. Task get/cancel acknowledgements are
    // single task objects and pass through unvalidated.
    if (route.length === 3) {
      unique(array(response.data, 256), task)
      unique(array(response.active, 256), task)
      cursor(response.cursor)
    }
    return undefined
  }
  if (route[2] === "permission" || route[2] === "question") {
    unique(array(response.data, 64), (value) => {
      const item = object(value)
      owner(item.sessionID, sessionID)
      identifier(item.id, route[2] === "permission" ? "per_" : "que_")
      if (route[2] === "permission") {
        string(item.action, 64000)
        array(item.resources, 256).forEach((value) => string(value, 64000))
        optional(item.save, (value) => array(value, 64).forEach((pattern) => string(pattern, 4096)))
        return
      }
      const questions = array(item.questions, 32)
      if (!questions.length) invalid("empty question request")
      for (const value of questions) {
        const question = object(value)
        string(question.question, 64000)
        string(question.header, 1024)
        for (const flag of [question.multiple, question.custom]) {
          if (flag !== undefined && typeof flag !== "boolean") invalid("question options")
        }
        for (const value of array(question.options, 64)) {
          const option = object(value)
          string(option.label, 4096)
          string(option.description, 64000)
        }
      }
    })
    return undefined
  }
  if (route[2] === "input") {
    if (route.length === 5) {
      if (typeof response.data !== "boolean") invalid("input acknowledgement")
      return undefined
    }
    if (route.length !== 3) return undefined
    unique(array(response.data, 256), (value) => {
      const item = object(value)
      identifier(item.id, "msg_")
      owner(item.sessionID, sessionID)
      string(object(item.prompt).text)
      choice(item.delivery, ["steer", "queue"])
      optional(item.source, (value) => choice(value, sources))
      numeric(item.timeCreated)
    })
    return undefined
  }
  if (route[2] === "revert" && route[3] === "stage") {
    const submitted = object(parseResponse(string(init?.body)))
    revert(response.data, identifier(submitted.messageID, "msg_"))
    return undefined
  }
  if (route[2] === "goal") {
    if (response.data === null && (!init?.method || init.method === "GET")) return undefined
    const goal = object(response.data)
    identifier(goal.id, "goal_")
    owner(goal.sessionID, sessionID)
    if (!Number.isSafeInteger(numeric(goal.revision)) || Number(goal.revision) < 1) invalid("goal revision")
    string(goal.objective, 256000)
    choice(goal.status, ["active", "paused", "blocked", "usageLimited", "complete"])
    for (const field of ["tokensUsed", "timeUsedSeconds"]) if (numeric(goal[field]) < 0) invalid("goal usage")
    const time = object(goal.time)
    for (const field of ["created", "updated", "statusChanged"]) numeric(time[field])
    optional(time.completed, numeric)
    if (init?.body) {
      const submitted = object(parseResponse(string(init.body)))
      const expected = submitted.goalID ?? submitted.id
      if (expected !== undefined && identifier(expected, "goal_") !== goal.id) invalid("goal identity")
      if (submitted.expectedRevision !== undefined && Number(goal.revision) < numeric(submitted.expectedRevision))
        invalid("goal revision regressed")
    }
    return undefined
  }
  if (route[2] === "harness") {
    // Only what the harness view displays; patches and tool sources are never rendered.
    if (route.length === 3) {
      const state = object(response.data)
      optional(state.snapshot, harnessSnapshot)
      unique(array(state.proposals, 128), harnessProposal)
      array(state.reviewerRequests, 32).forEach((value) => string(object(value).request, 4000))
      for (const value of array(state.reviewerRuns, 50)) {
        const run = object(value)
        string(run.reviewerSessionID, 128)
        choice(run.outcome, [
          "unchanged",
          "no_output",
          "unparseable",
          "duplicate",
          "proposed",
          "applied",
          "unsafe",
          "failed",
          "timeout",
        ])
        optional(run.detail, (value) => string(value, 4000))
        numeric(run.timestamp)
      }
    } else if (route[3] === "proposal" && route[5] !== "apply") harnessProposal(response.data)
    else harnessSnapshot(response.data)
    return undefined
  }
  if (route[2] === "room") {
    const data = object(response.data)
    if (route[3] !== "entries") {
      const room = object(data.room)
      string(room.objective, 64000)
      choice(room.status, ["open", "closed"])
      for (const value of array(data.members, 512)) {
        string(object(value).name, 512)
        choice(object(value).state, ["active", "parked", "settled", "blocked", "left"])
      }
      for (const value of array(data.lanes, 256)) {
        const lane = object(value)
        string(lane.title, 4096)
        choice(lane.status, ["open", "claimed", "done", "blocked"])
        optional(lane.claimedByName, (name) => string(name, 512))
      }
      return undefined
    }
    const entries = init?.method === "POST" ? [data] : array(data.entries, 1000)
    if (init?.method !== "POST") numeric(data.head)
    for (const value of entries) {
      const entry = object(value)
      numeric(entry.seq)
      numeric(entry.timeCreated)
      string(entry.kind, 32)
      string(entry.text)
      string(object(entry.actor).name, 512)
      choice(object(entry.actor).type, ["leader", "worker", "human", "system"])
    }
    return undefined
  }
  if (route[2] === "shell") {
    const item = object(response.data)
    identifier(item.id, "msg_")
    choice(item.type, ["shell"])
    string(item.command)
    string(item.output)
    optional(item.status, (value) => choice(value, ["running", "completed", "cancelled", "timed_out", "failed"]))
    const submitted = object(parseResponse(string(init?.body)))
    if (submitted.id !== undefined && item.id !== submitted.id) invalid("shell message identity")
    return undefined
  }
  if (route[2] === "prompt" || route[2] === "command") {
    const admitted = object(response.data)
    owner(admitted.sessionID, sessionID)
    identifier(admitted.id, "msg_")
    const submitted = object(parseResponse(string(init?.body)))
    if (submitted.id !== undefined && admitted.id !== submitted.id) invalid(`${route[2]} message identity`)
    for (const key of ["admittedSeq", "promotedSeq"]) {
      if (admitted[key] !== undefined && (!Number.isSafeInteger(numeric(admitted[key])) || Number(admitted[key]) < 0))
        invalid("admission sequence")
    }
    if (admitted.prompt !== undefined) string(object(admitted.prompt).text)
    if (admitted.delivery !== undefined) choice(admitted.delivery, ["steer", "queue"])
    if (admitted.source !== undefined) choice(admitted.source, sources)
    if (admitted.agent !== undefined) name(admitted.agent)
    if (admitted.model !== undefined) modelRef(admitted.model)
    if (admitted.timeCreated !== undefined) numeric(admitted.timeCreated)
  }
  return undefined
}

export function invalid(field = "data"): never {
  throw new Error(`Invalid server response (${field}).`)
}

export function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) invalid("object expected")
  return value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function array(value: unknown, maximum: number) {
  if (!Array.isArray(value)) invalid("array expected")
  if (value.length > maximum) invalid(`collection exceeds ${maximum} items`)
  return value as unknown[]
}

export function string(value: unknown, maximum = 1024 * 1024) {
  if (typeof value !== "string" || value.length > maximum) invalid("text")
  return value
}

export function name(value: unknown) {
  const result = string(value, 512)
  if (!result || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(result))
    invalid("name")
  return result
}

export function identifier(value: unknown, prefix = "") {
  const result = string(value, 256)
  if (
    !result.startsWith(prefix) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result) ||
    result === "constructor" ||
    result === "prototype" ||
    result === "__proto__"
  )
    invalid("identifier")
  return result
}

export function numeric(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid("number")
  return value
}

const sources = ["user", "subagent_board", "subagent_settle", "subagent_advisory", "shell_job", "swarm_room"]

export function choice(value: unknown, allowed: readonly string[]) {
  if (!allowed.includes(string(value, 64))) invalid("status")
}

export function optional(value: unknown, check: (value: unknown) => unknown) {
  if (value !== undefined && value !== null) check(value)
}

export function checkDirectory(value: unknown) {
  const path = string(value, 4096)
  if (
    !path ||
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(path) ||
    !(path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path))
  )
    invalid("absolute directory")
}

function location(value: unknown) {
  const item = object(value)
  checkDirectory(item.directory)
  optional(item.workspaceID, identifier)
}

export function modelRef(value: unknown) {
  const model = object(value)
  name(model.id)
  name(model.providerID)
  optional(model.variant, (value) => (value === "" ? "" : name(value)))
}

function session(value: unknown, expectedID?: string) {
  const item = object(value)
  const id = identifier(item.id, "ses_")
  if (expectedID !== undefined && id !== expectedID) invalid("session identity")
  optional(item.parentID, (value) => identifier(value, "ses_"))
  string(item.title, 64000)
  location(item.location)
  const time = object(item.time)
  numeric(time.created)
  numeric(time.updated)
  if (Object.hasOwn(time, "archived")) numeric(time.archived)
  optional(item.agent, name)
  optional(item.model, modelRef)
  optional(item.revert, (value) => revert(value))
}

function revert(value: unknown, expectedMessageID?: string) {
  const item = object(value)
  const messageID = identifier(item.messageID, "msg_")
  if (expectedMessageID !== undefined && messageID !== expectedMessageID) invalid("revert message identity")
  optional(item.partID, identifier)
  optional(item.snapshot, (value) => string(value, 4096))
  optional(item.diff, (value) => string(value, 8 * 1024 * 1024))
  optional(item.files, (value) => {
    for (const entry of array(value, 2048)) {
      const file = object(entry)
      string(file.path, 4096)
      choice(file.status, ["added", "modified", "deleted"])
      for (const key of ["additions", "deletions"])
        if (!Number.isSafeInteger(numeric(file[key])) || Number(file[key]) < 0) invalid("revert line count")
      string(file.patch, 8 * 1024 * 1024)
    }
  })
}

function cursor(value: unknown) {
  const item = object(value)
  optional(item.next, (value) => string(value, 4096))
  optional(item.previous, (value) => string(value, 4096))
}

function harnessSnapshot(value: unknown) {
  const item = object(value)
  if (!Number.isSafeInteger(numeric(item.version)) || Number(item.version) < 1) invalid("harness version")
  choice(item.status, ["active", "superseded", "rolledBack"])
  choice(item.source, ["default", "proposal", "reload", "rollback"])
  harnessContent(item)
}

function harnessProposal(value: unknown) {
  const item = object(value)
  string(item.id, 128)
  if (!Number.isSafeInteger(numeric(item.baseVersion)) || Number(item.baseVersion) < 0) invalid("harness base version")
  string(item.summary, 4000)
  choice(item.status, ["draft", "pending", "approved", "applied", "rejected", "failed"])
  optional(item.appliedVersion, numeric)
  harnessContent(item)
}

function harnessContent(item: Record<string, unknown>) {
  for (const value of array(item.changes ?? [], 128)) {
    const change = object(value)
    string(change.path, 4096)
    choice(change.operation, ["add", "modify", "delete"])
    optional(change.summary, (value) => string(value, 4000))
  }
  for (const value of array(item.tools ?? [], 64)) {
    const tool = object(value)
    string(tool.name, 64)
    string(tool.description, 2000)
    if (typeof tool.enabled !== "boolean" || typeof tool.readOnly !== "boolean") invalid("harness tool")
  }
  for (const value of array(item.guidance ?? [], 24)) {
    const guidance = object(value)
    string(guidance.directive, 600)
    optional(guidance.appliesTo, (value) => string(value, 4096))
  }
  const validation = object(item.validation)
  choice(validation.status, ["pending", "passed", "failed"])
  for (const key of ["errors", "warnings"]) array(validation[key], 64).forEach((value) => string(value, 2000))
}

function unique(items: unknown[], check: (value: unknown) => void) {
  const ids = new Set<string>()
  for (const item of items) {
    check(item)
    const id = name(object(item).id)
    if (ids.has(id)) invalid("duplicate identifier")
    ids.add(id)
  }
}

function owner(value: unknown, sessionID: string) {
  if (identifier(value, "ses_") !== sessionID) invalid("session identity")
}

function message(value: unknown, sessionID: string) {
  const item = object(value)
  identifier(item.id, "msg_")
  optional(item.sessionID, (value) => owner(value, sessionID))
  numeric(object(item.time).created)
  choice(item.type, [
    "user",
    "synthetic",
    "system",
    "assistant",
    "shell",
    "agent-switched",
    "model-switched",
    "compaction",
  ])
  if (item.type === "user" || item.type === "synthetic" || item.type === "system") string(item.text)
  if (item.type === "user" && item.source !== undefined && !sources.includes(item.source as string))
    invalid("message source")
  if (item.type === "agent-switched") name(item.agent)
  if (item.type === "model-switched") modelRef(item.model)
  if (item.type === "shell") {
    string(item.command)
    string(item.output)
    optional(item.error, string)
    optional(item.status, (value) => choice(value, ["running", "completed", "cancelled", "timed_out", "failed"]))
  }
  if (item.type !== "assistant") return
  name(item.agent)
  modelRef(item.model)
  optional(item.error, (value) => string(object(value).message))
  // The context meter adds these up.
  optional(item.tokens, (value) => {
    const tokens = object(value)
    for (const count of [
      tokens.input,
      tokens.output,
      tokens.reasoning,
      object(tokens.cache).read,
      object(tokens.cache).write,
    ])
      if (numeric(count) < 0) invalid("token count")
  })
  // The Changes view lists the files a turn touched.
  optional(item.snapshot, (value) =>
    optional(object(value).files, (files) => array(files, 5000).forEach((file) => string(file, 4096))),
  )
  unique(array(item.content, 128), (value) => {
    const part = object(value)
    choice(part.type, ["text", "reasoning", "tool"])
    if (part.type !== "tool") {
      string(part.text)
      return
    }
    name(part.name)
    const state = object(part.state)
    choice(state.status, ["pending", "running", "completed", "error"])
    if (state.status === "pending") return
    for (const value of array(state.content, 128)) {
      const content = object(value)
      choice(content.type, ["text", "file"])
      string(content.type === "text" ? content.text : content.uri)
    }
    if (state.status === "error") string(object(state.error).message)
  })
}

function task(value: unknown) {
  const item = object(value)
  identifier(item.id, "tsk_")
  for (const key of ["rootSessionID", "parentSessionID", "childSessionID"]) identifier(item[key], "ses_")
  name(item.agent)
  string(item.description)
  optional(item.error, string)
  choice(item.status, ["queued", "starting", "running", "completed", "failed", "cancelled", "interrupted"])
}
