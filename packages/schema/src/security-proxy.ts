export * as SecurityProxy from "./security-proxy"

import { Schema } from "effect"
import { optional } from "./schema"

const text = (max: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(max)))
const id = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/)))

export const Owner = Schema.Struct({
  directory: text(4096),
  workspaceID: optional(id),
  sessionID: optional(Schema.String.pipe(Schema.check(Schema.isStartsWith("ses")))),
}).annotate({
  identifier: "SecurityProxy.Owner",
})
export interface Owner extends Schema.Schema.Type<typeof Owner> {}

export const Header = Schema.Struct({ name: text(256), value: text(8192) }).annotate({
  identifier: "SecurityProxy.Header",
})
export interface Header extends Schema.Schema.Type<typeof Header> {}
export const Headers = Schema.Array(Header)
  .pipe(Schema.check(Schema.isMaxLength(256)))
  .annotate({ identifier: "SecurityProxy.Headers" })

export const Body = Schema.Struct({
  data: text(1_398_104),
  encoding: Schema.Literals(["utf8", "base64"]),
  state: Schema.Literals(["complete", "truncated", "unavailable", "streaming"]),
  size: Schema.Number,
}).annotate({ identifier: "SecurityProxy.Body" })
export interface Body extends Schema.Schema.Type<typeof Body> {}

export const Message = Schema.Struct({ url: text(4096), method: text(64), headers: Headers, body: Body }).annotate({
  identifier: "SecurityProxy.Message",
})
export interface Message extends Schema.Schema.Type<typeof Message> {}

export const Rule = Schema.Struct({
  id,
  enabled: Schema.Boolean,
  stage: Schema.Literals(["request", "response"]),
  path: text(4096),
  method: text(64),
  action: Schema.Literals(["pass", "pause", "replace"]),
  find: text(4096),
  replace: text(4096),
}).annotate({ identifier: "SecurityProxy.Rule" })
export interface Rule extends Schema.Schema.Type<typeof Rule> {}
export const Rules = Schema.Array(Rule)
  .pipe(Schema.check(Schema.isMaxLength(100)))
  .annotate({ identifier: "SecurityProxy.Rules" })

export const Create = Schema.Struct({
  id,
  name: text(200),
}).annotate({ identifier: "SecurityProxy.Create" })
export interface Create extends Schema.Schema.Type<typeof Create> {}
export const Case = Schema.Struct({
  ...Create.fields,
  owner: Owner,
  revision: Schema.Number,
  createdAt: Schema.Number,
  rules: Rules,
}).annotate({ identifier: "SecurityProxy.Case" })
export interface Case extends Schema.Schema.Type<typeof Case> {}

export const Flow = Schema.Struct({
  id,
  caseID: id,
  source: Schema.Literals(["browser", "replay"]),
  request: Message,
  originalRequest: optional(Message),
  responseHeaders: Headers,
  responseBody: Body,
  originalResponse: optional(Schema.Struct({ status: Schema.Number, headers: Headers, body: Body })),
  status: optional(Schema.Number),
  state: Schema.Literals(["complete", "dropped", "failed", "unknown"]),
  createdAt: Schema.Number,
  durationMs: optional(Schema.Number),
  error: optional(text(1024)),
  parentID: optional(id),
  note: text(4096),
}).annotate({ identifier: "SecurityProxy.Flow" })
export interface Flow extends Schema.Schema.Type<typeof Flow> {}

export const Pause = Schema.Struct({
  id,
  generation: id,
  stage: Schema.Literals(["request", "response"]),
  request: Message,
  status: optional(Schema.Number),
  headers: Headers,
  body: Body,
  deadline: Schema.Number,
  reading: Schema.Boolean,
}).annotate({ identifier: "SecurityProxy.Pause" })
export interface Pause extends Schema.Schema.Type<typeof Pause> {}

export const Snapshot = Schema.Struct({
  caseID: id,
  generation: id,
  open: Schema.Boolean,
  url: text(4096),
  intercept: Schema.Boolean,
  error: optional(text(1024)),
  pauses: Schema.Array(Pause),
}).annotate({ identifier: "SecurityProxy.Snapshot" })
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

export const Edits = Schema.Struct({
  url: optional(text(4096)),
  method: optional(text(64)),
  headers: optional(Headers),
  body: optional(Body),
  status: optional(Schema.Number),
}).annotate({ identifier: "SecurityProxy.Edits" })
export interface Edits extends Schema.Schema.Type<typeof Edits> {}

const owned = { owner: Owner, caseID: id }
const simple = <const T extends string>(type: T) => Schema.Struct({ type: Schema.Literal(type), ...owned })
const selectedFlow = <const T extends string>(type: T) =>
  Schema.Struct({ type: Schema.Literal(type), ...owned, flowID: id })
const list = Schema.Struct({ type: Schema.Literal("list"), owner: Owner })
const create = Schema.Struct({ type: Schema.Literal("create"), owner: Owner, input: Create })
const note = Schema.Struct({ type: Schema.Literal("note"), ...owned, flowID: id, note: text(4096) })
const rules = Schema.Struct({ type: Schema.Literal("rules"), ...owned, revision: Schema.Number, rules: Rules })
export const Command = Schema.Union([
  list,
  create,
  simple("get"),
  simple("delete"),
  simple("flows"),
  simple("open"),
  simple("close"),
  simple("snapshot"),
  simple("reset"),
  Schema.Struct({ type: Schema.Literal("navigate"), ...owned, url: text(4096) }),
  selectedFlow("flow"),
  selectedFlow("reveal"),
  note,
  rules,
  Schema.Struct({
    type: Schema.Literal("intercept"),
    ...owned,
    on: Schema.Boolean,
    settle: Schema.Literals(["drop", "forward"]),
  }),
  Schema.Struct({
    type: Schema.Literal("decide"),
    ...owned,
    pauseID: id,
    generation: id,
    decision: Schema.Literals(["forward", "drop", "read", "reveal", "extend"]),
    edits: optional(Edits),
  }),
  Schema.Struct({
    type: Schema.Literal("replay"),
    ...owned,
    flowID: id,
    replayID: id,
    auth: Schema.Literals(["captured", "live"]),
    edits: optional(Edits),
  }),
]).annotate({ identifier: "SecurityProxy.Command" })
export type Command = Schema.Schema.Type<typeof Command>

export const StoreCommand = Schema.Union([
  list,
  create,
  simple("get"),
  simple("delete"),
  simple("flows"),
  selectedFlow("flow"),
  selectedFlow("reveal"),
  note,
  rules,
  Schema.Struct({ type: Schema.Literal("put"), ...owned, flow: Flow }),
  Schema.Struct({ type: Schema.Literal("reserve"), ...owned, flow: Flow }),
]).annotate({ identifier: "SecurityProxy.StoreCommand" })
export type StoreCommand = Schema.Schema.Type<typeof StoreCommand>

export const Result = Schema.Struct({
  cases: optional(Schema.Array(Case)),
  case: optional(Case),
  flows: optional(Schema.Array(Flow)),
  flow: optional(Flow),
  pause: optional(Pause),
  snapshot: optional(Snapshot),
  created: optional(Schema.Boolean),
}).annotate({ identifier: "SecurityProxy.Result" })
export interface Result extends Schema.Schema.Type<typeof Result> {}

export type Platform = { invoke(command: Command): Promise<Result> }
