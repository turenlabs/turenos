import type { ForgeEventEncoded } from "@turenlabs/protocol/groups/event"

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export type UnauthorizedError = { readonly _tag: "UnauthorizedError"; readonly message: string }
export const isUnauthorizedError = (value: unknown): value is UnauthorizedError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "UnauthorizedError"

export type InvalidRequestError = {
  readonly _tag: "InvalidRequestError"
  readonly message: string
  readonly kind?: string | undefined
  readonly field?: string | undefined
}
export const isInvalidRequestError = (value: unknown): value is InvalidRequestError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "InvalidRequestError"

export type InvalidCursorError = { readonly _tag: "InvalidCursorError"; readonly message: string }
export const isInvalidCursorError = (value: unknown): value is InvalidCursorError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "InvalidCursorError"

export type SessionNotFoundError = {
  readonly _tag: "SessionNotFoundError"
  readonly sessionID: string
  readonly message: string
}
export const isSessionNotFoundError = (value: unknown): value is SessionNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "SessionNotFoundError"

export type ConflictError = {
  readonly _tag: "ConflictError"
  readonly message: string
  readonly resource?: string | undefined
}
export const isConflictError = (value: unknown): value is ConflictError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ConflictError"

export type ServiceUnavailableError = {
  readonly _tag: "ServiceUnavailableError"
  readonly message: string
  readonly service?: string | undefined
}
export const isServiceUnavailableError = (value: unknown): value is ServiceUnavailableError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ServiceUnavailableError"

export type SwarmRoomNotFoundError = { readonly _tag: "SwarmRoomNotFoundError"; readonly resource: string }
export const isSwarmRoomNotFoundError = (value: unknown): value is SwarmRoomNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "SwarmRoomNotFoundError"

export type SwarmRoomConflictError = {
  readonly _tag: "SwarmRoomConflictError"
  readonly message: string
  readonly head: number
}
export const isSwarmRoomConflictError = (value: unknown): value is SwarmRoomConflictError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "SwarmRoomConflictError"

export type SwarmRoomInvalidStateError = { readonly _tag: "SwarmRoomInvalidStateError"; readonly message: string }
export const isSwarmRoomInvalidStateError = (value: unknown): value is SwarmRoomInvalidStateError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "SwarmRoomInvalidStateError"

export type SwarmRoomForbiddenError = { readonly _tag: "SwarmRoomForbiddenError"; readonly message: string }
export const isSwarmRoomForbiddenError = (value: unknown): value is SwarmRoomForbiddenError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "SwarmRoomForbiddenError"

export type MessageNotFoundError = {
  readonly _tag: "MessageNotFoundError"
  readonly sessionID: string
  readonly messageID: string
  readonly message: string
}
export const isMessageNotFoundError = (value: unknown): value is MessageNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "MessageNotFoundError"

export type UnknownError = {
  readonly _tag: "UnknownError"
  readonly message: string
  readonly ref?: string | undefined
}
export const isUnknownError = (value: unknown): value is UnknownError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "UnknownError"

export type PermissionNotFoundError = {
  readonly _tag: "PermissionNotFoundError"
  readonly requestID: string
  readonly message: string
}
export const isPermissionNotFoundError = (value: unknown): value is PermissionNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "PermissionNotFoundError"

export type PtyNotFoundError = { readonly _tag: "PtyNotFoundError"; readonly ptyID: string; readonly message: string }
export const isPtyNotFoundError = (value: unknown): value is PtyNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "PtyNotFoundError"

export type QuestionNotFoundError = {
  readonly _tag: "QuestionNotFoundError"
  readonly requestID: string
  readonly message: string
}
export const isQuestionNotFoundError = (value: unknown): value is QuestionNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "QuestionNotFoundError"

export type ProjectCopyError = {
  readonly name: "ProjectCopyError"
  readonly data: { readonly message: string; readonly forceRequired?: boolean | undefined }
}
export const isProjectCopyError = (value: unknown): value is ProjectCopyError =>
  typeof value === "object" && value !== null && "name" in value && value["name"] === "ProjectCopyError"

export type MemoryNotFoundError = { readonly _tag: "MemoryNotFoundError"; readonly message: string }
export const isMemoryNotFoundError = (value: unknown): value is MemoryNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "MemoryNotFoundError"

export type LoopNotFoundError = {
  readonly _tag: "LoopNotFoundError"
  readonly loopID: string
  readonly message: string
}
export const isLoopNotFoundError = (value: unknown): value is LoopNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "LoopNotFoundError"

export type LoopRunNotFoundError = {
  readonly _tag: "LoopRunNotFoundError"
  readonly loopID: string
  readonly runID: string
  readonly message: string
}
export const isLoopRunNotFoundError = (value: unknown): value is LoopRunNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "LoopRunNotFoundError"

export type IntelFeedNotFoundError = {
  readonly _tag: "IntelFeedNotFoundError"
  readonly feedID: string
  readonly message: string
}
export const isIntelFeedNotFoundError = (value: unknown): value is IntelFeedNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "IntelFeedNotFoundError"

export type WhiteboardNotFoundError = { readonly _tag: "WhiteboardNotFoundError"; readonly sessionID: string }
export const isWhiteboardNotFoundError = (value: unknown): value is WhiteboardNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "WhiteboardNotFoundError"

export type WhiteboardValidationError = { readonly _tag: "WhiteboardValidationError"; readonly message: string }
export const isWhiteboardValidationError = (value: unknown): value is WhiteboardValidationError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "WhiteboardValidationError"

export type WhiteboardConflictError = {
  readonly _tag: "WhiteboardConflictError"
  readonly sessionID: string
  readonly expectedRevision: number
  readonly actualRevision: number
  readonly message: string
}
export const isWhiteboardConflictError = (value: unknown): value is WhiteboardConflictError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "WhiteboardConflictError"

export type HealthGetOutput = { readonly healthy: true }

export type LocationGetInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type LocationGetOutput = {
  readonly directory: string
  readonly workspaceID?: string
  readonly project: { readonly id: string; readonly directory: string }
}

export type AgentsListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type AgentsListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly request: {
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
    }
    readonly system?: string
    readonly description?: string
    readonly mode: "subagent" | "primary" | "all"
    readonly hidden: boolean
    readonly tools?: boolean
    readonly color?: string | "primary" | "secondary" | "accent" | "success" | "warning" | "error" | "info"
    readonly steps?: number
    readonly permissions: ReadonlyArray<{
      readonly action: string
      readonly resource: string
      readonly effect: "allow" | "deny" | "ask"
    }>
  }>
}

export type SessionsListInput = {
  readonly workspace?: {
    readonly workspace?: string | undefined
    readonly roots?: boolean | undefined
    readonly archived?: boolean | undefined
    readonly internal?: "lobby" | undefined
    readonly inactive?: boolean | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["workspace"]
  readonly roots?: {
    readonly workspace?: string | undefined
    readonly roots?: boolean | undefined
    readonly archived?: boolean | undefined
    readonly internal?: "lobby" | undefined
    readonly inactive?: boolean | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["roots"]
  readonly archived?: {
    readonly workspace?: string | undefined
    readonly roots?: boolean | undefined
    readonly archived?: boolean | undefined
    readonly internal?: "lobby" | undefined
    readonly inactive?: boolean | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["archived"]
  readonly internal?: {
    readonly workspace?: string | undefined
    readonly roots?: boolean | undefined
    readonly archived?: boolean | undefined
    readonly internal?: "lobby" | undefined
    readonly inactive?: boolean | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["internal"]
  readonly inactive?: {
    readonly workspace?: string | undefined
    readonly roots?: boolean | undefined
    readonly archived?: boolean | undefined
    readonly internal?: "lobby" | undefined
    readonly inactive?: boolean | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["inactive"]
  readonly limit?: {
    readonly workspace?: string | undefined
    readonly roots?: boolean | undefined
    readonly archived?: boolean | undefined
    readonly internal?: "lobby" | undefined
    readonly inactive?: boolean | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["limit"]
  readonly order?: {
    readonly workspace?: string | undefined
    readonly roots?: boolean | undefined
    readonly archived?: boolean | undefined
    readonly internal?: "lobby" | undefined
    readonly inactive?: boolean | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["order"]
  readonly search?: {
    readonly workspace?: string | undefined
    readonly roots?: boolean | undefined
    readonly archived?: boolean | undefined
    readonly internal?: "lobby" | undefined
    readonly inactive?: boolean | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["search"]
  readonly directory?: {
    readonly workspace?: string | undefined
    readonly roots?: boolean | undefined
    readonly archived?: boolean | undefined
    readonly internal?: "lobby" | undefined
    readonly inactive?: boolean | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["directory"]
  readonly project?: {
    readonly workspace?: string | undefined
    readonly roots?: boolean | undefined
    readonly archived?: boolean | undefined
    readonly internal?: "lobby" | undefined
    readonly inactive?: boolean | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["project"]
  readonly subpath?: {
    readonly workspace?: string | undefined
    readonly roots?: boolean | undefined
    readonly archived?: boolean | undefined
    readonly internal?: "lobby" | undefined
    readonly inactive?: boolean | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["subpath"]
  readonly cursor?: {
    readonly workspace?: string | undefined
    readonly roots?: boolean | undefined
    readonly archived?: boolean | undefined
    readonly internal?: "lobby" | undefined
    readonly inactive?: boolean | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["cursor"]
}

export type SessionsListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly parentID?: string
    readonly projectID: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly cost: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
    readonly title: string
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly subpath?: string
    readonly revert?: {
      readonly messageID: string
      readonly partID?: string
      readonly snapshot?: string
      readonly diff?: string
      readonly files?: ReadonlyArray<{
        readonly path: string
        readonly status: "added" | "modified" | "deleted"
        readonly additions: number
        readonly deletions: number
        readonly patch: string
      }>
    }
  }>
  readonly cursor: { readonly previous?: string | null; readonly next?: string | null }
}

export type SessionsCreateInput = {
  readonly id?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly metadata?: { readonly [x: string]: JsonValue } | null
    readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
  }["id"]
  readonly agent?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly metadata?: { readonly [x: string]: JsonValue } | null
    readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
  }["agent"]
  readonly model?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly metadata?: { readonly [x: string]: JsonValue } | null
    readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
  }["model"]
  readonly metadata?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly metadata?: { readonly [x: string]: JsonValue } | null
    readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
  }["metadata"]
  readonly location?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly metadata?: { readonly [x: string]: JsonValue } | null
    readonly location?: { readonly directory: string; readonly workspaceID?: string } | null
  }["location"]
}

export type SessionsCreateOutput = {
  readonly data: {
    readonly id: string
    readonly parentID?: string
    readonly projectID: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly cost: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
    readonly title: string
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly subpath?: string
    readonly revert?: {
      readonly messageID: string
      readonly partID?: string
      readonly snapshot?: string
      readonly diff?: string
      readonly files?: ReadonlyArray<{
        readonly path: string
        readonly status: "added" | "modified" | "deleted"
        readonly additions: number
        readonly deletions: number
        readonly patch: string
      }>
    }
  }
}["data"]

export type SessionsReplayInput = {
  readonly query?: {
    readonly query?: string | undefined
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
  }["query"]
  readonly limit?: {
    readonly query?: string | undefined
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
  }["limit"]
  readonly cursor?: {
    readonly query?: string | undefined
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
  }["cursor"]
}

export type SessionsReplayOutput = {
  readonly data: ReadonlyArray<{
    readonly kind: "session" | "event"
    readonly session: {
      readonly id: string
      readonly parentID?: string
      readonly projectID: string
      readonly agent?: string
      readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
      readonly metadata?: { readonly [x: string]: JsonValue }
      readonly cost: number
      readonly tokens: {
        readonly input: number
        readonly output: number
        readonly reasoning: number
        readonly cache: { readonly read: number; readonly write: number }
      }
      readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
      readonly title: string
      readonly location: { readonly directory: string; readonly workspaceID?: string }
      readonly subpath?: string
      readonly revert?: {
        readonly messageID: string
        readonly partID?: string
        readonly snapshot?: string
        readonly diff?: string
        readonly files?: ReadonlyArray<{
          readonly path: string
          readonly status: "added" | "modified" | "deleted"
          readonly additions: number
          readonly deletions: number
          readonly patch: string
        }>
      }
    }
    readonly event?: {
      readonly id: string
      readonly aggregateID: string
      readonly seq: number
      readonly type: string
      readonly timestamp: number
      readonly messageID?: string | null
      readonly preview: string
    } | null
    readonly score: number
  }>
  readonly total: number
  readonly nextCursor?: string | null
  readonly index: { readonly status: "indexing" | "ready"; readonly progress: number }
  readonly parsed: {
    readonly text: ReadonlyArray<string>
    readonly filters: ReadonlyArray<{
      readonly field:
        | "session"
        | "id"
        | "message"
        | "call"
        | "type"
        | "agent"
        | "model"
        | "tool"
        | "status"
        | "path"
        | "after"
        | "before"
        | "has"
        | "is"
      readonly value: string
      readonly negated: boolean
    }>
  }
}

export type SessionsActiveOutput = { readonly data: { readonly [x: string]: { readonly type: "running" } } }["data"]

export type SessionsInterruptAllOutput = {
  readonly data: { readonly interrupted: number; readonly failed: number }
}["data"]

export type SessionsGetInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsGetOutput = {
  readonly data: {
    readonly id: string
    readonly parentID?: string
    readonly projectID: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly cost: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
    readonly title: string
    readonly location: { readonly directory: string; readonly workspaceID?: string }
    readonly subpath?: string
    readonly revert?: {
      readonly messageID: string
      readonly partID?: string
      readonly snapshot?: string
      readonly diff?: string
      readonly files?: ReadonlyArray<{
        readonly path: string
        readonly status: "added" | "modified" | "deleted"
        readonly additions: number
        readonly deletions: number
        readonly patch: string
      }>
    }
  }
}["data"]

export type SessionsGetTerminalInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsGetTerminalOutput = {
  readonly data: {
    readonly ptyID: string
    readonly shared: boolean
    readonly info: {
      readonly id: string
      readonly title: string
      readonly command: string
      readonly args: ReadonlyArray<string>
      readonly cwd: string
      readonly status: "running" | "exited"
      readonly pid: number
      readonly exitCode?: number
    }
    readonly workspaceID?: string | null
  } | null
}["data"]

export type SessionsCreateTerminalInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsCreateTerminalOutput = {
  readonly data: {
    readonly ptyID: string
    readonly shared: boolean
    readonly info: {
      readonly id: string
      readonly title: string
      readonly command: string
      readonly args: ReadonlyArray<string>
      readonly cwd: string
      readonly status: "running" | "exited"
      readonly pid: number
      readonly exitCode?: number
    }
    readonly workspaceID?: string | null
  }
}["data"]

export type SessionsShareTerminalInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly shared: { readonly shared: boolean }["shared"]
}

export type SessionsShareTerminalOutput = {
  readonly data: {
    readonly ptyID: string
    readonly shared: boolean
    readonly info: {
      readonly id: string
      readonly title: string
      readonly command: string
      readonly args: ReadonlyArray<string>
      readonly cwd: string
      readonly status: "running" | "exited"
      readonly pid: number
      readonly exitCode?: number
    }
    readonly workspaceID?: string | null
  }
}["data"]

export type SessionsRemoveTerminalInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsRemoveTerminalOutput = void

export type SessionsStateInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsStateOutput = {
  readonly data: {
    readonly snapshot: {
      readonly version: number
      readonly parent?: number
      readonly status: "active" | "superseded" | "rolledBack"
      readonly source: "default" | "proposal" | "reload" | "rollback"
      readonly changes: ReadonlyArray<{
        readonly path: string
        readonly operation: "add" | "modify" | "delete"
        readonly summary?: string
        readonly patch?: string
        readonly content?: string
      }>
      readonly tools: ReadonlyArray<{
        readonly name: string
        readonly description: string
        readonly source?: string
        readonly readOnly: boolean
        readonly enabled: boolean
      }>
      readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
      readonly validation: {
        readonly status: "pending" | "passed" | "failed"
        readonly errors: ReadonlyArray<string>
        readonly warnings: ReadonlyArray<string>
      }
      readonly timestamps: { readonly created: number; readonly updated: number }
    } | null
    readonly proposals: ReadonlyArray<{
      readonly id: string
      readonly baseVersion: number
      readonly summary: string
      readonly changes: ReadonlyArray<{
        readonly path: string
        readonly operation: "add" | "modify" | "delete"
        readonly summary?: string
        readonly patch?: string
        readonly content?: string
      }>
      readonly tools?: ReadonlyArray<{
        readonly name: string
        readonly description: string
        readonly source?: string
        readonly readOnly: boolean
        readonly enabled: boolean
      }>
      readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
      readonly status: "draft" | "pending" | "approved" | "applied" | "rejected" | "failed"
      readonly appliedVersion?: number
      readonly validation: {
        readonly status: "pending" | "passed" | "failed"
        readonly errors: ReadonlyArray<string>
        readonly warnings: ReadonlyArray<string>
      }
      readonly timestamps: { readonly created: number; readonly updated: number }
    }>
    readonly reviewerRequests: ReadonlyArray<{
      readonly id: string
      readonly request: string
      readonly timestamps: { readonly created: number; readonly updated: number }
    }>
    readonly reviewerRuns: ReadonlyArray<{
      readonly reviewerSessionID: string
      readonly outcome:
        | "unchanged"
        | "no_output"
        | "unparseable"
        | "duplicate"
        | "proposed"
        | "applied"
        | "unsafe"
        | "failed"
        | "timeout"
      readonly detail?: string
      readonly timestamp: number
    }>
  }
}["data"]

export type SessionsProposalInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string
    readonly baseVersion: number
    readonly summary: string
    readonly changes?: ReadonlyArray<{
      readonly path: string
      readonly operation: "add" | "modify" | "delete"
      readonly summary?: string
      readonly patch?: string
      readonly content?: string
    }>
    readonly tools?: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly source?: string
      readonly readOnly: boolean
      readonly enabled: boolean
    }>
    readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
  }["id"]
  readonly baseVersion: {
    readonly id?: string
    readonly baseVersion: number
    readonly summary: string
    readonly changes?: ReadonlyArray<{
      readonly path: string
      readonly operation: "add" | "modify" | "delete"
      readonly summary?: string
      readonly patch?: string
      readonly content?: string
    }>
    readonly tools?: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly source?: string
      readonly readOnly: boolean
      readonly enabled: boolean
    }>
    readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
  }["baseVersion"]
  readonly summary: {
    readonly id?: string
    readonly baseVersion: number
    readonly summary: string
    readonly changes?: ReadonlyArray<{
      readonly path: string
      readonly operation: "add" | "modify" | "delete"
      readonly summary?: string
      readonly patch?: string
      readonly content?: string
    }>
    readonly tools?: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly source?: string
      readonly readOnly: boolean
      readonly enabled: boolean
    }>
    readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
  }["summary"]
  readonly changes?: {
    readonly id?: string
    readonly baseVersion: number
    readonly summary: string
    readonly changes?: ReadonlyArray<{
      readonly path: string
      readonly operation: "add" | "modify" | "delete"
      readonly summary?: string
      readonly patch?: string
      readonly content?: string
    }>
    readonly tools?: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly source?: string
      readonly readOnly: boolean
      readonly enabled: boolean
    }>
    readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
  }["changes"]
  readonly tools?: {
    readonly id?: string
    readonly baseVersion: number
    readonly summary: string
    readonly changes?: ReadonlyArray<{
      readonly path: string
      readonly operation: "add" | "modify" | "delete"
      readonly summary?: string
      readonly patch?: string
      readonly content?: string
    }>
    readonly tools?: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly source?: string
      readonly readOnly: boolean
      readonly enabled: boolean
    }>
    readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
  }["tools"]
  readonly guidance?: {
    readonly id?: string
    readonly baseVersion: number
    readonly summary: string
    readonly changes?: ReadonlyArray<{
      readonly path: string
      readonly operation: "add" | "modify" | "delete"
      readonly summary?: string
      readonly patch?: string
      readonly content?: string
    }>
    readonly tools?: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly source?: string
      readonly readOnly: boolean
      readonly enabled: boolean
    }>
    readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
  }["guidance"]
}

export type SessionsProposalOutput = {
  readonly data: {
    readonly id: string
    readonly baseVersion: number
    readonly summary: string
    readonly changes: ReadonlyArray<{
      readonly path: string
      readonly operation: "add" | "modify" | "delete"
      readonly summary?: string
      readonly patch?: string
      readonly content?: string
    }>
    readonly tools?: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly source?: string
      readonly readOnly: boolean
      readonly enabled: boolean
    }>
    readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
    readonly status: "draft" | "pending" | "approved" | "applied" | "rejected" | "failed"
    readonly appliedVersion?: number
    readonly validation: {
      readonly status: "pending" | "passed" | "failed"
      readonly errors: ReadonlyArray<string>
      readonly warnings: ReadonlyArray<string>
    }
    readonly timestamps: { readonly created: number; readonly updated: number }
  }
}["data"]

export type SessionsProposalStatusInput = {
  readonly sessionID: { readonly sessionID: string; readonly proposalID: string }["sessionID"]
  readonly proposalID: { readonly sessionID: string; readonly proposalID: string }["proposalID"]
  readonly status: {
    readonly status: "draft" | "pending" | "approved" | "applied" | "rejected" | "failed"
    readonly validation?: {
      readonly status: "pending" | "passed" | "failed"
      readonly errors: ReadonlyArray<string>
      readonly warnings: ReadonlyArray<string>
    }
  }["status"]
  readonly validation?: {
    readonly status: "draft" | "pending" | "approved" | "applied" | "rejected" | "failed"
    readonly validation?: {
      readonly status: "pending" | "passed" | "failed"
      readonly errors: ReadonlyArray<string>
      readonly warnings: ReadonlyArray<string>
    }
  }["validation"]
}

export type SessionsProposalStatusOutput = {
  readonly data: {
    readonly id: string
    readonly baseVersion: number
    readonly summary: string
    readonly changes: ReadonlyArray<{
      readonly path: string
      readonly operation: "add" | "modify" | "delete"
      readonly summary?: string
      readonly patch?: string
      readonly content?: string
    }>
    readonly tools?: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly source?: string
      readonly readOnly: boolean
      readonly enabled: boolean
    }>
    readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
    readonly status: "draft" | "pending" | "approved" | "applied" | "rejected" | "failed"
    readonly appliedVersion?: number
    readonly validation: {
      readonly status: "pending" | "passed" | "failed"
      readonly errors: ReadonlyArray<string>
      readonly warnings: ReadonlyArray<string>
    }
    readonly timestamps: { readonly created: number; readonly updated: number }
  }
}["data"]

export type SessionsProposalApplyInput = {
  readonly sessionID: { readonly sessionID: string; readonly proposalID: string }["sessionID"]
  readonly proposalID: { readonly sessionID: string; readonly proposalID: string }["proposalID"]
}

export type SessionsProposalApplyOutput = {
  readonly data: {
    readonly version: number
    readonly parent?: number
    readonly status: "active" | "superseded" | "rolledBack"
    readonly source: "default" | "proposal" | "reload" | "rollback"
    readonly changes: ReadonlyArray<{
      readonly path: string
      readonly operation: "add" | "modify" | "delete"
      readonly summary?: string
      readonly patch?: string
      readonly content?: string
    }>
    readonly tools: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly source?: string
      readonly readOnly: boolean
      readonly enabled: boolean
    }>
    readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
    readonly validation: {
      readonly status: "pending" | "passed" | "failed"
      readonly errors: ReadonlyArray<string>
      readonly warnings: ReadonlyArray<string>
    }
    readonly timestamps: { readonly created: number; readonly updated: number }
  }
}["data"]

export type SessionsProposalRejectInput = {
  readonly sessionID: { readonly sessionID: string; readonly proposalID: string }["sessionID"]
  readonly proposalID: { readonly sessionID: string; readonly proposalID: string }["proposalID"]
}

export type SessionsProposalRejectOutput = {
  readonly data: {
    readonly id: string
    readonly baseVersion: number
    readonly summary: string
    readonly changes: ReadonlyArray<{
      readonly path: string
      readonly operation: "add" | "modify" | "delete"
      readonly summary?: string
      readonly patch?: string
      readonly content?: string
    }>
    readonly tools?: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly source?: string
      readonly readOnly: boolean
      readonly enabled: boolean
    }>
    readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
    readonly status: "draft" | "pending" | "approved" | "applied" | "rejected" | "failed"
    readonly appliedVersion?: number
    readonly validation: {
      readonly status: "pending" | "passed" | "failed"
      readonly errors: ReadonlyArray<string>
      readonly warnings: ReadonlyArray<string>
    }
    readonly timestamps: { readonly created: number; readonly updated: number }
  }
}["data"]

export type SessionsReloadInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly baseVersion: { readonly baseVersion: number }["baseVersion"]
}

export type SessionsReloadOutput = {
  readonly data: {
    readonly version: number
    readonly parent?: number
    readonly status: "active" | "superseded" | "rolledBack"
    readonly source: "default" | "proposal" | "reload" | "rollback"
    readonly changes: ReadonlyArray<{
      readonly path: string
      readonly operation: "add" | "modify" | "delete"
      readonly summary?: string
      readonly patch?: string
      readonly content?: string
    }>
    readonly tools: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly source?: string
      readonly readOnly: boolean
      readonly enabled: boolean
    }>
    readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
    readonly validation: {
      readonly status: "pending" | "passed" | "failed"
      readonly errors: ReadonlyArray<string>
      readonly warnings: ReadonlyArray<string>
    }
    readonly timestamps: { readonly created: number; readonly updated: number }
  }
}["data"]

export type SessionsRollbackInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly baseVersion: { readonly baseVersion: number; readonly version: number }["baseVersion"]
  readonly version: { readonly baseVersion: number; readonly version: number }["version"]
}

export type SessionsRollbackOutput = {
  readonly data: {
    readonly version: number
    readonly parent?: number
    readonly status: "active" | "superseded" | "rolledBack"
    readonly source: "default" | "proposal" | "reload" | "rollback"
    readonly changes: ReadonlyArray<{
      readonly path: string
      readonly operation: "add" | "modify" | "delete"
      readonly summary?: string
      readonly patch?: string
      readonly content?: string
    }>
    readonly tools: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly source?: string
      readonly readOnly: boolean
      readonly enabled: boolean
    }>
    readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
    readonly validation: {
      readonly status: "pending" | "passed" | "failed"
      readonly errors: ReadonlyArray<string>
      readonly warnings: ReadonlyArray<string>
    }
    readonly timestamps: { readonly created: number; readonly updated: number }
  }
}["data"]

export type SessionsSwitchAgentInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly agent: { readonly agent: string }["agent"]
}

export type SessionsSwitchAgentOutput = void

export type SessionsSwitchModelInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly model: {
    readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
  }["model"]
}

export type SessionsSwitchModelOutput = void

export type SessionsPromptInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly parts?: ReadonlyArray<{
        readonly id: string
        readonly text: string
        readonly synthetic?: boolean
        readonly ignored?: boolean
        readonly metadata?: {
          readonly forgeComment?: {
            readonly path: string
            readonly selection?: {
              readonly startLine: number
              readonly startChar: number
              readonly endLine: number
              readonly endChar: number
            }
            readonly comment: string
            readonly preview?: string
            readonly origin?: "review" | "file"
          }
          readonly forgeSwarm?:
            | {
                readonly status: "ready"
                readonly objective: string
                readonly count: number
                readonly explicitCount: boolean
              }
            | {
                readonly status: "invalid"
                readonly objective: string
                readonly reason: "missing_objective" | "count_out_of_range"
                readonly requestedCount?: string | null
              }
        }
      }>
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery?: "steer" | "queue" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly resume?: boolean | null
  }["id"]
  readonly prompt: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly parts?: ReadonlyArray<{
        readonly id: string
        readonly text: string
        readonly synthetic?: boolean
        readonly ignored?: boolean
        readonly metadata?: {
          readonly forgeComment?: {
            readonly path: string
            readonly selection?: {
              readonly startLine: number
              readonly startChar: number
              readonly endLine: number
              readonly endChar: number
            }
            readonly comment: string
            readonly preview?: string
            readonly origin?: "review" | "file"
          }
          readonly forgeSwarm?:
            | {
                readonly status: "ready"
                readonly objective: string
                readonly count: number
                readonly explicitCount: boolean
              }
            | {
                readonly status: "invalid"
                readonly objective: string
                readonly reason: "missing_objective" | "count_out_of_range"
                readonly requestedCount?: string | null
              }
        }
      }>
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery?: "steer" | "queue" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly resume?: boolean | null
  }["prompt"]
  readonly delivery?: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly parts?: ReadonlyArray<{
        readonly id: string
        readonly text: string
        readonly synthetic?: boolean
        readonly ignored?: boolean
        readonly metadata?: {
          readonly forgeComment?: {
            readonly path: string
            readonly selection?: {
              readonly startLine: number
              readonly startChar: number
              readonly endLine: number
              readonly endChar: number
            }
            readonly comment: string
            readonly preview?: string
            readonly origin?: "review" | "file"
          }
          readonly forgeSwarm?:
            | {
                readonly status: "ready"
                readonly objective: string
                readonly count: number
                readonly explicitCount: boolean
              }
            | {
                readonly status: "invalid"
                readonly objective: string
                readonly reason: "missing_objective" | "count_out_of_range"
                readonly requestedCount?: string | null
              }
        }
      }>
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery?: "steer" | "queue" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly resume?: boolean | null
  }["delivery"]
  readonly agent?: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly parts?: ReadonlyArray<{
        readonly id: string
        readonly text: string
        readonly synthetic?: boolean
        readonly ignored?: boolean
        readonly metadata?: {
          readonly forgeComment?: {
            readonly path: string
            readonly selection?: {
              readonly startLine: number
              readonly startChar: number
              readonly endLine: number
              readonly endChar: number
            }
            readonly comment: string
            readonly preview?: string
            readonly origin?: "review" | "file"
          }
          readonly forgeSwarm?:
            | {
                readonly status: "ready"
                readonly objective: string
                readonly count: number
                readonly explicitCount: boolean
              }
            | {
                readonly status: "invalid"
                readonly objective: string
                readonly reason: "missing_objective" | "count_out_of_range"
                readonly requestedCount?: string | null
              }
        }
      }>
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery?: "steer" | "queue" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly resume?: boolean | null
  }["agent"]
  readonly model?: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly parts?: ReadonlyArray<{
        readonly id: string
        readonly text: string
        readonly synthetic?: boolean
        readonly ignored?: boolean
        readonly metadata?: {
          readonly forgeComment?: {
            readonly path: string
            readonly selection?: {
              readonly startLine: number
              readonly startChar: number
              readonly endLine: number
              readonly endChar: number
            }
            readonly comment: string
            readonly preview?: string
            readonly origin?: "review" | "file"
          }
          readonly forgeSwarm?:
            | {
                readonly status: "ready"
                readonly objective: string
                readonly count: number
                readonly explicitCount: boolean
              }
            | {
                readonly status: "invalid"
                readonly objective: string
                readonly reason: "missing_objective" | "count_out_of_range"
                readonly requestedCount?: string | null
              }
        }
      }>
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery?: "steer" | "queue" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly resume?: boolean | null
  }["model"]
  readonly resume?: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly parts?: ReadonlyArray<{
        readonly id: string
        readonly text: string
        readonly synthetic?: boolean
        readonly ignored?: boolean
        readonly metadata?: {
          readonly forgeComment?: {
            readonly path: string
            readonly selection?: {
              readonly startLine: number
              readonly startChar: number
              readonly endLine: number
              readonly endChar: number
            }
            readonly comment: string
            readonly preview?: string
            readonly origin?: "review" | "file"
          }
          readonly forgeSwarm?:
            | {
                readonly status: "ready"
                readonly objective: string
                readonly count: number
                readonly explicitCount: boolean
              }
            | {
                readonly status: "invalid"
                readonly objective: string
                readonly reason: "missing_objective" | "count_out_of_range"
                readonly requestedCount?: string | null
              }
        }
      }>
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery?: "steer" | "queue" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly resume?: boolean | null
  }["resume"]
}

export type SessionsPromptOutput = {
  readonly data: {
    readonly admittedSeq: number
    readonly id: string
    readonly sessionID: string
    readonly prompt: {
      readonly text: string
      readonly parts?: ReadonlyArray<{
        readonly id: string
        readonly text: string
        readonly synthetic?: boolean
        readonly ignored?: boolean
        readonly metadata?: {
          readonly forgeComment?: {
            readonly path: string
            readonly selection?: {
              readonly startLine: number
              readonly startChar: number
              readonly endLine: number
              readonly endChar: number
            }
            readonly comment: string
            readonly preview?: string
            readonly origin?: "review" | "file"
          }
          readonly forgeSwarm?:
            | {
                readonly status: "ready"
                readonly objective: string
                readonly count: number
                readonly explicitCount: boolean
              }
            | {
                readonly status: "invalid"
                readonly objective: string
                readonly reason: "missing_objective" | "count_out_of_range"
                readonly requestedCount?: string | null
              }
        }
      }>
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery: "steer" | "queue"
    readonly source?: "user" | "subagent_board" | "subagent_settle" | "subagent_advisory" | "shell_job" | "swarm_room"
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly timeCreated: number
    readonly promotedSeq?: number
  }
}["data"]

export type SessionsShellInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string | undefined
    readonly command: string
    readonly timeout?: number | undefined
  }["id"]
  readonly command: {
    readonly id?: string | undefined
    readonly command: string
    readonly timeout?: number | undefined
  }["command"]
  readonly timeout?: {
    readonly id?: string | undefined
    readonly command: string
    readonly timeout?: number | undefined
  }["timeout"]
}

export type SessionsShellOutput = {
  readonly data: {
    readonly id: string
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly time: { readonly created: number; readonly completed?: number }
    readonly type: "shell"
    readonly callID: string
    readonly command: string
    readonly timeout?: number
    readonly output: string
    readonly status?: "running" | "completed" | "cancelled" | "timed_out" | "failed"
    readonly exitCode?: number
    readonly truncated?: boolean
    readonly error?: string
  }
}["data"]

export type SessionsCommandInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string | null
    readonly command: string
    readonly arguments: string
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly files?: ReadonlyArray<{
      readonly uri: string
      readonly name?: string
      readonly description?: string
      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
    }> | null
    readonly resume?: boolean | null
  }["id"]
  readonly command: {
    readonly id?: string | null
    readonly command: string
    readonly arguments: string
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly files?: ReadonlyArray<{
      readonly uri: string
      readonly name?: string
      readonly description?: string
      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
    }> | null
    readonly resume?: boolean | null
  }["command"]
  readonly arguments: {
    readonly id?: string | null
    readonly command: string
    readonly arguments: string
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly files?: ReadonlyArray<{
      readonly uri: string
      readonly name?: string
      readonly description?: string
      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
    }> | null
    readonly resume?: boolean | null
  }["arguments"]
  readonly agent?: {
    readonly id?: string | null
    readonly command: string
    readonly arguments: string
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly files?: ReadonlyArray<{
      readonly uri: string
      readonly name?: string
      readonly description?: string
      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
    }> | null
    readonly resume?: boolean | null
  }["agent"]
  readonly model?: {
    readonly id?: string | null
    readonly command: string
    readonly arguments: string
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly files?: ReadonlyArray<{
      readonly uri: string
      readonly name?: string
      readonly description?: string
      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
    }> | null
    readonly resume?: boolean | null
  }["model"]
  readonly files?: {
    readonly id?: string | null
    readonly command: string
    readonly arguments: string
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly files?: ReadonlyArray<{
      readonly uri: string
      readonly name?: string
      readonly description?: string
      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
    }> | null
    readonly resume?: boolean | null
  }["files"]
  readonly resume?: {
    readonly id?: string | null
    readonly command: string
    readonly arguments: string
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly files?: ReadonlyArray<{
      readonly uri: string
      readonly name?: string
      readonly description?: string
      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
    }> | null
    readonly resume?: boolean | null
  }["resume"]
}

export type SessionsCommandOutput = {
  readonly data: {
    readonly admittedSeq: number
    readonly id: string
    readonly sessionID: string
    readonly prompt: {
      readonly text: string
      readonly parts?: ReadonlyArray<{
        readonly id: string
        readonly text: string
        readonly synthetic?: boolean
        readonly ignored?: boolean
        readonly metadata?: {
          readonly forgeComment?: {
            readonly path: string
            readonly selection?: {
              readonly startLine: number
              readonly startChar: number
              readonly endLine: number
              readonly endChar: number
            }
            readonly comment: string
            readonly preview?: string
            readonly origin?: "review" | "file"
          }
          readonly forgeSwarm?:
            | {
                readonly status: "ready"
                readonly objective: string
                readonly count: number
                readonly explicitCount: boolean
              }
            | {
                readonly status: "invalid"
                readonly objective: string
                readonly reason: "missing_objective" | "count_out_of_range"
                readonly requestedCount?: string | null
              }
        }
      }>
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery: "steer" | "queue"
    readonly source?: "user" | "subagent_board" | "subagent_settle" | "subagent_advisory" | "shell_job" | "swarm_room"
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly timeCreated: number
    readonly promotedSeq?: number
  }
}["data"]

export type SessionsResumeInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsResumeOutput = {
  readonly data:
    | { readonly status: "scheduled" }
    | { readonly status: "running" }
    | {
        readonly status: "interrupted"
        readonly assistantMessageID: string
        readonly reason: string
        readonly next: "scheduled" | "idle"
      }
    | {
        readonly status: "interrupted"
        readonly shellMessageID: string
        readonly reason: string
        readonly next: "scheduled" | "idle"
      }
    | { readonly status: "idle" }
}["data"]

export type SessionsGoalGetInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsGoalGetOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly revision: number
    readonly objective: string
    readonly status: "active" | "paused" | "blocked" | "usageLimited" | "complete"
    readonly tokensUsed: number
    readonly timeUsedSeconds: number
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly statusChanged: number
      readonly completed?: number
    }
  } | null
}["data"]

export type SessionsGoalSetInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string | null
    readonly messageID?: string | null
    readonly objective: string
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
  }["id"]
  readonly messageID?: {
    readonly id?: string | null
    readonly messageID?: string | null
    readonly objective: string
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
  }["messageID"]
  readonly objective: {
    readonly id?: string | null
    readonly messageID?: string | null
    readonly objective: string
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
  }["objective"]
  readonly agent?: {
    readonly id?: string | null
    readonly messageID?: string | null
    readonly objective: string
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
  }["agent"]
  readonly model?: {
    readonly id?: string | null
    readonly messageID?: string | null
    readonly objective: string
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
  }["model"]
}

export type SessionsGoalSetOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly revision: number
    readonly objective: string
    readonly status: "active" | "paused" | "blocked" | "usageLimited" | "complete"
    readonly tokensUsed: number
    readonly timeUsedSeconds: number
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly statusChanged: number
      readonly completed?: number
    }
  }
}["data"]

export type SessionsGoalEditInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly goalID: { readonly goalID: string; readonly expectedRevision: number; readonly objective: string }["goalID"]
  readonly expectedRevision: {
    readonly goalID: string
    readonly expectedRevision: number
    readonly objective: string
  }["expectedRevision"]
  readonly objective: {
    readonly goalID: string
    readonly expectedRevision: number
    readonly objective: string
  }["objective"]
}

export type SessionsGoalEditOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly revision: number
    readonly objective: string
    readonly status: "active" | "paused" | "blocked" | "usageLimited" | "complete"
    readonly tokensUsed: number
    readonly timeUsedSeconds: number
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly statusChanged: number
      readonly completed?: number
    }
  }
}["data"]

export type SessionsGoalStatusInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly goalID: {
    readonly goalID: string
    readonly expectedRevision: number
    readonly status: "active" | "paused" | "blocked" | "usageLimited" | "complete"
  }["goalID"]
  readonly expectedRevision: {
    readonly goalID: string
    readonly expectedRevision: number
    readonly status: "active" | "paused" | "blocked" | "usageLimited" | "complete"
  }["expectedRevision"]
  readonly status: {
    readonly goalID: string
    readonly expectedRevision: number
    readonly status: "active" | "paused" | "blocked" | "usageLimited" | "complete"
  }["status"]
}

export type SessionsGoalStatusOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly revision: number
    readonly objective: string
    readonly status: "active" | "paused" | "blocked" | "usageLimited" | "complete"
    readonly tokensUsed: number
    readonly timeUsedSeconds: number
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly statusChanged: number
      readonly completed?: number
    }
  }
}["data"]

export type SessionsGoalClearInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly goalID: { readonly goalID: string; readonly expectedRevision: number }["goalID"]
  readonly expectedRevision: { readonly goalID: string; readonly expectedRevision: number }["expectedRevision"]
}

export type SessionsGoalClearOutput = void

export type SessionsTaskListInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: { readonly limit?: number | undefined; readonly cursor?: string | undefined }["limit"]
  readonly cursor?: { readonly limit?: number | undefined; readonly cursor?: string | undefined }["cursor"]
}

export type SessionsTaskListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly rootSessionID: string
    readonly parentSessionID: string
    readonly childSessionID: string
    readonly parentTaskID?: string | null
    readonly agent: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly description: string
    readonly depth: number
    readonly status: "queued" | "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted"
    readonly revision: number
    readonly result?: string | null
    readonly error?: string | null
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly completed?: number
    }
  }>
  readonly active: ReadonlyArray<{
    readonly id: string
    readonly rootSessionID: string
    readonly parentSessionID: string
    readonly childSessionID: string
    readonly parentTaskID?: string | null
    readonly agent: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly description: string
    readonly depth: number
    readonly status: "queued" | "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted"
    readonly revision: number
    readonly result?: string | null
    readonly error?: string | null
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly completed?: number
    }
  }>
  readonly cursor: { readonly next?: string | null }
}

export type SessionsTaskGetInput = {
  readonly sessionID: { readonly sessionID: string; readonly taskID: string }["sessionID"]
  readonly taskID: { readonly sessionID: string; readonly taskID: string }["taskID"]
}

export type SessionsTaskGetOutput = {
  readonly data: {
    readonly id: string
    readonly rootSessionID: string
    readonly parentSessionID: string
    readonly childSessionID: string
    readonly parentTaskID?: string | null
    readonly actor: { readonly sessionID: string; readonly assistantMessageID: string; readonly toolCallID: string }
    readonly agent: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly prompt: { readonly text: string }
    readonly description: string
    readonly depth: number
    readonly status: "queued" | "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted"
    readonly revision: number
    readonly authority: {
      readonly parentPermissions: ReadonlyArray<{
        readonly action: string
        readonly resource: string
        readonly effect: "allow" | "deny" | "ask"
      }>
      readonly ancestorPermissionSets: ReadonlyArray<
        ReadonlyArray<{ readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" }>
      >
      readonly childPermissions: ReadonlyArray<{
        readonly action: string
        readonly resource: string
        readonly effect: "allow" | "deny" | "ask"
      }>
      readonly hardPermissions: ReadonlyArray<{
        readonly action: string
        readonly resource: string
        readonly effect: "allow" | "deny" | "ask"
      }>
      readonly writeRoots: ReadonlyArray<string>
      readonly commands: ReadonlyArray<string>
    }
    readonly result?: string | null
    readonly error?: string | null
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly completed?: number
    }
  }
}["data"]

export type SessionsTaskCancelInput = {
  readonly sessionID: { readonly sessionID: string; readonly taskID: string }["sessionID"]
  readonly taskID: { readonly sessionID: string; readonly taskID: string }["taskID"]
  readonly expectedRevision?: { readonly expectedRevision?: number | undefined }["expectedRevision"]
}

export type SessionsTaskCancelOutput = {
  readonly data: {
    readonly id: string
    readonly rootSessionID: string
    readonly parentSessionID: string
    readonly childSessionID: string
    readonly parentTaskID?: string | null
    readonly actor: { readonly sessionID: string; readonly assistantMessageID: string; readonly toolCallID: string }
    readonly agent: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly prompt: { readonly text: string }
    readonly description: string
    readonly depth: number
    readonly status: "queued" | "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted"
    readonly revision: number
    readonly authority: {
      readonly parentPermissions: ReadonlyArray<{
        readonly action: string
        readonly resource: string
        readonly effect: "allow" | "deny" | "ask"
      }>
      readonly ancestorPermissionSets: ReadonlyArray<
        ReadonlyArray<{ readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" }>
      >
      readonly childPermissions: ReadonlyArray<{
        readonly action: string
        readonly resource: string
        readonly effect: "allow" | "deny" | "ask"
      }>
      readonly hardPermissions: ReadonlyArray<{
        readonly action: string
        readonly resource: string
        readonly effect: "allow" | "deny" | "ask"
      }>
      readonly writeRoots: ReadonlyArray<string>
      readonly commands: ReadonlyArray<string>
    }
    readonly result?: string | null
    readonly error?: string | null
    readonly time: {
      readonly created: number
      readonly updated: number
      readonly started?: number
      readonly completed?: number
    }
  }
}["data"]

export type SessionsTeamBoardInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsTeamBoardOutput = {
  readonly data: {
    readonly notes: ReadonlyArray<{
      readonly id: string
      readonly rootSessionID: string
      readonly authorSessionID: string
      readonly authorAgent: string
      readonly kind: "finding" | "correction" | "lead" | "refuted" | "capability" | "status"
      readonly title: string
      readonly body: string
      readonly evidence?: string
      readonly supersedes?: string
      readonly supersededBy?: string
      readonly revision: number
      readonly timeCreated: number
      readonly timeUpdated: number
    }>
  }
}["data"]

export type SessionsSwarmRoomInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsSwarmRoomOutput = {
  readonly data: {
    readonly room: {
      readonly id: string
      readonly rootSessionID: string
      readonly objective: string
      readonly budget: number
      readonly explicitBudget: boolean
      readonly head: number
      readonly status: "open" | "closed"
      readonly timeCreated: number
      readonly timeUpdated: number
    }
    readonly members: ReadonlyArray<{
      readonly id: string
      readonly roomID: string
      readonly type: "leader" | "worker" | "human" | "system"
      readonly sessionID?: string
      readonly taskID?: string
      readonly agent?: string
      readonly name: string
      readonly state: "active" | "parked" | "settled" | "blocked" | "left"
      readonly joinedAt: number
    }>
    readonly lanes: ReadonlyArray<{
      readonly key: string
      readonly title: string
      readonly detail?: string
      readonly status: "open" | "claimed" | "done" | "blocked"
      readonly claimedBy?: string
      readonly claimedByName?: string
      readonly updatedSeq: number
    }>
  }
}["data"]

export type SessionsSwarmRoomEntriesInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly after?: { readonly after?: number | undefined; readonly limit?: number | undefined }["after"]
  readonly limit?: { readonly after?: number | undefined; readonly limit?: number | undefined }["limit"]
}

export type SessionsSwarmRoomEntriesOutput = {
  readonly data: {
    readonly entries: ReadonlyArray<{
      readonly id: string
      readonly roomID: string
      readonly seq: number
      readonly actor: {
        readonly type: "leader" | "worker" | "human" | "system"
        readonly memberID: string
        readonly sessionID?: string
        readonly agent?: string
        readonly name: string
      }
      readonly kind:
        | "message"
        | "plan"
        | "claim"
        | "release"
        | "decision"
        | "finding"
        | "correction"
        | "lead"
        | "status"
        | "question"
      readonly text: string
      readonly payload?: JsonValue
      readonly replyTo?: string
      readonly evidenceRefs?: ReadonlyArray<string>
      readonly baseRevision: number
      readonly timeCreated: number
    }>
    readonly head: number
    readonly hasMore: boolean
  }
}["data"]

export type SessionsSwarmRoomPostInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly text: { readonly text: string; readonly name?: string; readonly replyTo?: string }["text"]
  readonly name?: { readonly text: string; readonly name?: string; readonly replyTo?: string }["name"]
  readonly replyTo?: { readonly text: string; readonly name?: string; readonly replyTo?: string }["replyTo"]
}

export type SessionsSwarmRoomPostOutput = {
  readonly data: {
    readonly id: string
    readonly roomID: string
    readonly seq: number
    readonly actor: {
      readonly type: "leader" | "worker" | "human" | "system"
      readonly memberID: string
      readonly sessionID?: string
      readonly agent?: string
      readonly name: string
    }
    readonly kind:
      | "message"
      | "plan"
      | "claim"
      | "release"
      | "decision"
      | "finding"
      | "correction"
      | "lead"
      | "status"
      | "question"
    readonly text: string
    readonly payload?: JsonValue
    readonly replyTo?: string
    readonly evidenceRefs?: ReadonlyArray<string>
    readonly baseRevision: number
    readonly timeCreated: number
  }
}["data"]

export type SessionsCompactInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsCompactOutput = void

export type SessionsWaitInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsWaitOutput = void

export type SessionsStageInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly messageID: { readonly messageID: string; readonly files?: boolean | undefined }["messageID"]
  readonly files?: { readonly messageID: string; readonly files?: boolean | undefined }["files"]
}

export type SessionsStageOutput = {
  readonly data: {
    readonly messageID: string
    readonly partID?: string
    readonly snapshot?: string
    readonly diff?: string
    readonly files?: ReadonlyArray<{
      readonly path: string
      readonly status: "added" | "modified" | "deleted"
      readonly additions: number
      readonly deletions: number
      readonly patch: string
    }>
  }
}["data"]

export type SessionsClearInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsClearOutput = void

export type SessionsCommitInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsCommitOutput = void

export type SessionsContextInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsContextOutput = {
  readonly data: ReadonlyArray<
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "agent-switched"
        readonly agent: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "model-switched"
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly source?:
          | "user"
          | "subagent_board"
          | "subagent_settle"
          | "subagent_advisory"
          | "shell_job"
          | "swarm_room"
        readonly text: string
        readonly parts?: ReadonlyArray<{
          readonly id: string
          readonly text: string
          readonly synthetic?: boolean
          readonly ignored?: boolean
          readonly metadata?: {
            readonly forgeComment?: {
              readonly path: string
              readonly selection?: {
                readonly startLine: number
                readonly startChar: number
                readonly endLine: number
                readonly endChar: number
              }
              readonly comment: string
              readonly preview?: string
              readonly origin?: "review" | "file"
            }
            readonly forgeSwarm?:
              | {
                  readonly status: "ready"
                  readonly objective: string
                  readonly count: number
                  readonly explicitCount: boolean
                }
              | {
                  readonly status: "invalid"
                  readonly objective: string
                  readonly reason: "missing_objective" | "count_out_of_range"
                  readonly requestedCount?: string | null
                }
          }
        }>
        readonly files?: ReadonlyArray<{
          readonly uri: string
          readonly mime: string
          readonly name?: string
          readonly description?: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly agents?: ReadonlyArray<{
          readonly name: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly type: "user"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly sessionID: string
        readonly text: string
        readonly type: "synthetic"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "system"
        readonly text: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "shell"
        readonly callID: string
        readonly command: string
        readonly timeout?: number
        readonly output: string
        readonly status?: "running" | "completed" | "cancelled" | "timed_out" | "failed"
        readonly exitCode?: number
        readonly truncated?: boolean
        readonly error?: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "assistant"
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly id: string; readonly text: string }
          | {
              readonly type: "reasoning"
              readonly id: string
              readonly text: string
              readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              readonly time?: { readonly created: number; readonly completed?: number }
            }
          | {
              readonly type: "tool"
              readonly id: string
              readonly name: string
              readonly truncated?: { readonly bytes: number }
              readonly provider?: {
                readonly executed: boolean
                readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
                readonly resultMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              }
              readonly state:
                | { readonly status: "pending"; readonly input: string }
                | {
                    readonly status: "running"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                  }
                | {
                    readonly status: "completed"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly attachments?: ReadonlyArray<{
                      readonly uri: string
                      readonly mime: string
                      readonly name?: string
                      readonly description?: string
                      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
                    }>
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly outputPaths?: ReadonlyArray<string>
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly result?: JsonValue
                  }
                | {
                    readonly status: "error"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly error: { readonly type: "unknown"; readonly message: string }
                    readonly result?: JsonValue
                  }
              readonly time: {
                readonly created: number
                readonly ran?: number
                readonly completed?: number
                readonly pruned?: number
              }
            }
        >
        readonly snapshot?: { readonly start?: string; readonly end?: string; readonly files?: ReadonlyArray<string> }
        readonly finish?: string
        readonly cost?: number
        readonly tokens?: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly error?: { readonly type: "unknown"; readonly message: string }
      }
    | {
        readonly type: "compaction"
        readonly reason: "auto" | "manual"
        readonly summary: string
        readonly recent: string
        readonly ledger?: ReadonlyArray<string>
        readonly throughSeq?: number
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
      }
  >
}["data"]

export type SessionsPendingInputsInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsPendingInputsOutput = {
  readonly data: ReadonlyArray<{
    readonly admittedSeq: number
    readonly id: string
    readonly sessionID: string
    readonly prompt: {
      readonly text: string
      readonly parts?: ReadonlyArray<{
        readonly id: string
        readonly text: string
        readonly synthetic?: boolean
        readonly ignored?: boolean
        readonly metadata?: {
          readonly forgeComment?: {
            readonly path: string
            readonly selection?: {
              readonly startLine: number
              readonly startChar: number
              readonly endLine: number
              readonly endChar: number
            }
            readonly comment: string
            readonly preview?: string
            readonly origin?: "review" | "file"
          }
          readonly forgeSwarm?:
            | {
                readonly status: "ready"
                readonly objective: string
                readonly count: number
                readonly explicitCount: boolean
              }
            | {
                readonly status: "invalid"
                readonly objective: string
                readonly reason: "missing_objective" | "count_out_of_range"
                readonly requestedCount?: string | null
              }
        }
      }>
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery: "steer" | "queue"
    readonly source?: "user" | "subagent_board" | "subagent_settle" | "subagent_advisory" | "shell_job" | "swarm_room"
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly timeCreated: number
    readonly promotedSeq?: number
  }>
}["data"]

export type SessionsInputStatusInput = {
  readonly sessionID: { readonly sessionID: string; readonly messageID: string }["sessionID"]
  readonly messageID: { readonly sessionID: string; readonly messageID: string }["messageID"]
}

export type SessionsInputStatusOutput = {
  readonly data?: {
    readonly admittedSeq: number
    readonly id: string
    readonly sessionID: string
    readonly prompt: {
      readonly text: string
      readonly parts?: ReadonlyArray<{
        readonly id: string
        readonly text: string
        readonly synthetic?: boolean
        readonly ignored?: boolean
        readonly metadata?: {
          readonly forgeComment?: {
            readonly path: string
            readonly selection?: {
              readonly startLine: number
              readonly startChar: number
              readonly endLine: number
              readonly endChar: number
            }
            readonly comment: string
            readonly preview?: string
            readonly origin?: "review" | "file"
          }
          readonly forgeSwarm?:
            | {
                readonly status: "ready"
                readonly objective: string
                readonly count: number
                readonly explicitCount: boolean
              }
            | {
                readonly status: "invalid"
                readonly objective: string
                readonly reason: "missing_objective" | "count_out_of_range"
                readonly requestedCount?: string | null
              }
        }
      }>
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery: "steer" | "queue"
    readonly source?: "user" | "subagent_board" | "subagent_settle" | "subagent_advisory" | "shell_job" | "swarm_room"
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly timeCreated: number
    readonly promotedSeq?: number
    readonly status: "admitted" | "promoted" | "cancelled"
    readonly timeCancelled?: number
  } | null
}["data"]

export type SessionsOutboxInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: {
    readonly limit?: number | undefined
    readonly cursor?: number | undefined
    readonly status?: "admitted" | "promoted" | "cancelled" | undefined
  }["limit"]
  readonly cursor?: {
    readonly limit?: number | undefined
    readonly cursor?: number | undefined
    readonly status?: "admitted" | "promoted" | "cancelled" | undefined
  }["cursor"]
  readonly status?: {
    readonly limit?: number | undefined
    readonly cursor?: number | undefined
    readonly status?: "admitted" | "promoted" | "cancelled" | undefined
  }["status"]
}

export type SessionsOutboxOutput = {
  readonly data: ReadonlyArray<{
    readonly admittedSeq: number
    readonly id: string
    readonly sessionID: string
    readonly prompt: {
      readonly text: string
      readonly parts?: ReadonlyArray<{
        readonly id: string
        readonly text: string
        readonly synthetic?: boolean
        readonly ignored?: boolean
        readonly metadata?: {
          readonly forgeComment?: {
            readonly path: string
            readonly selection?: {
              readonly startLine: number
              readonly startChar: number
              readonly endLine: number
              readonly endChar: number
            }
            readonly comment: string
            readonly preview?: string
            readonly origin?: "review" | "file"
          }
          readonly forgeSwarm?:
            | {
                readonly status: "ready"
                readonly objective: string
                readonly count: number
                readonly explicitCount: boolean
              }
            | {
                readonly status: "invalid"
                readonly objective: string
                readonly reason: "missing_objective" | "count_out_of_range"
                readonly requestedCount?: string | null
              }
        }
      }>
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery: "steer" | "queue"
    readonly source?: "user" | "subagent_board" | "subagent_settle" | "subagent_advisory" | "shell_job" | "swarm_room"
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly timeCreated: number
    readonly promotedSeq?: number
    readonly status: "admitted" | "promoted" | "cancelled"
    readonly timeCancelled?: number
  }>
  readonly next?: number | null
}

export type SessionsInputSteerInput = {
  readonly sessionID: { readonly sessionID: string; readonly messageID: string }["sessionID"]
  readonly messageID: { readonly sessionID: string; readonly messageID: string }["messageID"]
}

export type SessionsInputSteerOutput = { readonly data: boolean }["data"]

export type SessionsInputCancelInput = {
  readonly sessionID: { readonly sessionID: string; readonly messageID: string }["sessionID"]
  readonly messageID: { readonly sessionID: string; readonly messageID: string }["messageID"]
}

export type SessionsInputCancelOutput = { readonly data: boolean }["data"]

export type SessionsHistoryInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: { readonly limit?: number | undefined; readonly after?: number | undefined }["limit"]
  readonly after?: { readonly limit?: number | undefined; readonly after?: number | undefined }["after"]
}

export type SessionsHistoryOutput = {
  readonly data: ReadonlyArray<
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.agent.switched"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly agent: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.model.switched"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.title.updated"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: { readonly timestamp: number; readonly sessionID: string; readonly title: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.moved"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly location: { readonly directory: string; readonly workspaceID?: string }
          readonly subdirectory?: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.prompted"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly prompt: {
            readonly text: string
            readonly parts?: ReadonlyArray<{
              readonly id: string
              readonly text: string
              readonly synthetic?: boolean
              readonly ignored?: boolean
              readonly metadata?: {
                readonly forgeComment?: {
                  readonly path: string
                  readonly selection?: {
                    readonly startLine: number
                    readonly startChar: number
                    readonly endLine: number
                    readonly endChar: number
                  }
                  readonly comment: string
                  readonly preview?: string
                  readonly origin?: "review" | "file"
                }
                readonly forgeSwarm?:
                  | {
                      readonly status: "ready"
                      readonly objective: string
                      readonly count: number
                      readonly explicitCount: boolean
                    }
                  | {
                      readonly status: "invalid"
                      readonly objective: string
                      readonly reason: "missing_objective" | "count_out_of_range"
                      readonly requestedCount?: string | null
                    }
              }
            }>
            readonly files?: ReadonlyArray<{
              readonly uri: string
              readonly mime: string
              readonly name?: string
              readonly description?: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly agents?: ReadonlyArray<{
              readonly name: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
          }
          readonly delivery: "steer" | "queue"
          readonly source?:
            | "user"
            | "subagent_board"
            | "subagent_settle"
            | "subagent_advisory"
            | "shell_job"
            | "swarm_room"
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.prompt.admitted"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly prompt: {
            readonly text: string
            readonly parts?: ReadonlyArray<{
              readonly id: string
              readonly text: string
              readonly synthetic?: boolean
              readonly ignored?: boolean
              readonly metadata?: {
                readonly forgeComment?: {
                  readonly path: string
                  readonly selection?: {
                    readonly startLine: number
                    readonly startChar: number
                    readonly endLine: number
                    readonly endChar: number
                  }
                  readonly comment: string
                  readonly preview?: string
                  readonly origin?: "review" | "file"
                }
                readonly forgeSwarm?:
                  | {
                      readonly status: "ready"
                      readonly objective: string
                      readonly count: number
                      readonly explicitCount: boolean
                    }
                  | {
                      readonly status: "invalid"
                      readonly objective: string
                      readonly reason: "missing_objective" | "count_out_of_range"
                      readonly requestedCount?: string | null
                    }
              }
            }>
            readonly files?: ReadonlyArray<{
              readonly uri: string
              readonly mime: string
              readonly name?: string
              readonly description?: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly agents?: ReadonlyArray<{
              readonly name: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
          }
          readonly delivery: "steer" | "queue"
          readonly source?:
            | "user"
            | "subagent_board"
            | "subagent_settle"
            | "subagent_advisory"
            | "shell_job"
            | "swarm_room"
          readonly agent?: string
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          readonly command?: {
            readonly command: string
            readonly arguments: string
            readonly agent?: string
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
            readonly files?: ReadonlyArray<{
              readonly uri: string
              readonly name?: string
              readonly description?: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
          }
          readonly revert?: { readonly messageID: string }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.context.updated"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.synthetic"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.shell.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly callID: string
          readonly command: string
          readonly timeout?: number
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.shell.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly callID: string
          readonly output: string
          readonly status: "completed" | "cancelled" | "timed_out" | "failed"
          readonly exitCode?: number
          readonly truncated?: boolean
          readonly error?: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.step.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly agent: string
          readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
          readonly snapshot?: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.step.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly finish: string
          readonly cost: number
          readonly tokens: {
            readonly input: number
            readonly output: number
            readonly reasoning: number
            readonly cache: { readonly read: number; readonly write: number }
          }
          readonly billed?: {
            readonly input: number
            readonly output: number
            readonly reasoning: number
            readonly cache: { readonly read: number; readonly write: number }
          }
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          readonly snapshot?: string
          readonly files?: ReadonlyArray<string>
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.step.failed"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly error: { readonly type: "unknown"; readonly message: string }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.text.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly textID: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.text.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly textID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.input.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly name: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.input.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.called"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly tool: string
          readonly input: { readonly [x: string]: JsonValue }
          readonly provider: {
            readonly executed: boolean
            readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.progress"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly structured: { readonly [x: string]: JsonValue }
          readonly content: ReadonlyArray<
            | { readonly type: "text"; readonly text: string }
            | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
          >
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.success"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly structured: { readonly [x: string]: JsonValue }
          readonly content: ReadonlyArray<
            | { readonly type: "text"; readonly text: string }
            | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
          >
          readonly outputPaths?: ReadonlyArray<string>
          readonly result?: JsonValue
          readonly provider: {
            readonly executed: boolean
            readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.failed"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly error: { readonly type: "unknown"; readonly message: string }
          readonly result?: JsonValue
          readonly provider: {
            readonly executed: boolean
            readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.reasoning.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly reasoningID: string
          readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.reasoning.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly reasoningID: string
          readonly text: string
          readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.harness.proposal.created"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly proposal: {
            readonly id: string
            readonly baseVersion: number
            readonly summary: string
            readonly changes: ReadonlyArray<{
              readonly path: string
              readonly operation: "add" | "modify" | "delete"
              readonly summary?: string
              readonly patch?: string
              readonly content?: string
            }>
            readonly tools?: ReadonlyArray<{
              readonly name: string
              readonly description: string
              readonly source?: string
              readonly readOnly: boolean
              readonly enabled: boolean
            }>
            readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
            readonly status: "draft" | "pending" | "approved" | "applied" | "rejected" | "failed"
            readonly appliedVersion?: number
            readonly validation: {
              readonly status: "pending" | "passed" | "failed"
              readonly errors: ReadonlyArray<string>
              readonly warnings: ReadonlyArray<string>
            }
            readonly timestamps: { readonly created: number; readonly updated: number }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.harness.proposal.status"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly proposalID: string
          readonly status: "draft" | "pending" | "approved" | "applied" | "rejected" | "failed"
          readonly validation?: {
            readonly status: "pending" | "passed" | "failed"
            readonly errors: ReadonlyArray<string>
            readonly warnings: ReadonlyArray<string>
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.harness.snapshot.created"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly proposalID?: string
          readonly snapshot: {
            readonly version: number
            readonly parent?: number
            readonly status: "active" | "superseded" | "rolledBack"
            readonly source: "default" | "proposal" | "reload" | "rollback"
            readonly changes: ReadonlyArray<{
              readonly path: string
              readonly operation: "add" | "modify" | "delete"
              readonly summary?: string
              readonly patch?: string
              readonly content?: string
            }>
            readonly tools: ReadonlyArray<{
              readonly name: string
              readonly description: string
              readonly source?: string
              readonly readOnly: boolean
              readonly enabled: boolean
            }>
            readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
            readonly validation: {
              readonly status: "pending" | "passed" | "failed"
              readonly errors: ReadonlyArray<string>
              readonly warnings: ReadonlyArray<string>
            }
            readonly timestamps: { readonly created: number; readonly updated: number }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.harness.reloaded"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: { readonly timestamp: number; readonly sessionID: string; readonly version: number }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.retried"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly attempt: number
          readonly delay: number
          readonly error: {
            readonly message: string
            readonly statusCode?: number
            readonly isRetryable: boolean
            readonly responseHeaders?: { readonly [x: string]: string }
            readonly responseBody?: string
            readonly metadata?: { readonly [x: string]: string }
          }
          readonly action?: {
            readonly reason: string
            readonly provider: string
            readonly title: string
            readonly message: string
            readonly label: string
            readonly link?: string
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.compaction.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly reason: "auto" | "manual"
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.compaction.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly reason: "auto" | "manual"
          readonly text: string
          readonly recent: string
          readonly ledger?: ReadonlyArray<string>
          readonly throughSeq?: number
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.compaction.failed"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly mode: "auto" | "manual"
          readonly reason: string
          readonly detail?: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.compaction.pruned"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly entries: ReadonlyArray<{ readonly assistantMessageID: string; readonly callID: string }>
          readonly freed: number
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.revert.staged"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly revert: {
            readonly messageID: string
            readonly partID?: string
            readonly snapshot?: string
            readonly diff?: string
            readonly files?: ReadonlyArray<{
              readonly path: string
              readonly status: "added" | "modified" | "deleted"
              readonly additions: number
              readonly deletions: number
              readonly patch: string
            }>
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.revert.cleared"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: { readonly timestamp: number; readonly sessionID: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.revert.committed"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: { readonly timestamp: number; readonly sessionID: string; readonly messageID: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.goal.updated"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly goal: {
            readonly id: string
            readonly sessionID: string
            readonly revision: number
            readonly objective: string
            readonly status: "active" | "paused" | "blocked" | "usageLimited" | "complete"
            readonly tokensUsed: number
            readonly timeUsedSeconds: number
            readonly time: {
              readonly created: number
              readonly updated: number
              readonly statusChanged: number
              readonly completed?: number
            }
          }
          readonly activeTimeMs: number
          readonly admission?: {
            readonly messageID: string
            readonly prompt: {
              readonly text: string
              readonly parts?: ReadonlyArray<{
                readonly id: string
                readonly text: string
                readonly synthetic?: boolean
                readonly ignored?: boolean
                readonly metadata?: {
                  readonly forgeComment?: {
                    readonly path: string
                    readonly selection?: {
                      readonly startLine: number
                      readonly startChar: number
                      readonly endLine: number
                      readonly endChar: number
                    }
                    readonly comment: string
                    readonly preview?: string
                    readonly origin?: "review" | "file"
                  }
                  readonly forgeSwarm?:
                    | {
                        readonly status: "ready"
                        readonly objective: string
                        readonly count: number
                        readonly explicitCount: boolean
                      }
                    | {
                        readonly status: "invalid"
                        readonly objective: string
                        readonly reason: "missing_objective" | "count_out_of_range"
                        readonly requestedCount?: string | null
                      }
                }
              }>
              readonly files?: ReadonlyArray<{
                readonly uri: string
                readonly mime: string
                readonly name?: string
                readonly description?: string
                readonly source?: { readonly start: number; readonly end: number; readonly text: string }
              }>
              readonly agents?: ReadonlyArray<{
                readonly name: string
                readonly source?: { readonly start: number; readonly end: number; readonly text: string }
              }>
            }
            readonly delivery: "steer" | "queue"
            readonly agent?: string
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
            readonly revert?: { readonly messageID: string }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.goal.cleared"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly goalID: string
          readonly revision: number
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.task.updated"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly taskID: string
          readonly task: {
            readonly id: string
            readonly rootSessionID: string
            readonly parentSessionID: string
            readonly childSessionID: string
            readonly parentTaskID?: string
            readonly actor: {
              readonly sessionID: string
              readonly assistantMessageID: string
              readonly toolCallID: string
              readonly item?: number
            }
            readonly agent: string
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
            readonly prompt: {
              readonly text: string
              readonly parts?: ReadonlyArray<{
                readonly id: string
                readonly text: string
                readonly synthetic?: boolean
                readonly ignored?: boolean
                readonly metadata?: {
                  readonly forgeComment?: {
                    readonly path: string
                    readonly selection?: {
                      readonly startLine: number
                      readonly startChar: number
                      readonly endLine: number
                      readonly endChar: number
                    }
                    readonly comment: string
                    readonly preview?: string
                    readonly origin?: "review" | "file"
                  }
                  readonly forgeSwarm?:
                    | {
                        readonly status: "ready"
                        readonly objective: string
                        readonly count: number
                        readonly explicitCount: boolean
                      }
                    | {
                        readonly status: "invalid"
                        readonly objective: string
                        readonly reason: "missing_objective" | "count_out_of_range"
                        readonly requestedCount?: string | null
                      }
                }
              }>
              readonly files?: ReadonlyArray<{
                readonly uri: string
                readonly mime: string
                readonly name?: string
                readonly description?: string
                readonly source?: { readonly start: number; readonly end: number; readonly text: string }
              }>
              readonly agents?: ReadonlyArray<{
                readonly name: string
                readonly source?: { readonly start: number; readonly end: number; readonly text: string }
              }>
            }
            readonly description: string
            readonly wave?: string
            readonly depth: number
            readonly status: "queued" | "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted"
            readonly revision: number
            readonly authority: {
              readonly parentPermissions: ReadonlyArray<{
                readonly action: string
                readonly resource: string
                readonly effect: "allow" | "deny" | "ask"
              }>
              readonly ancestorPermissionSets: ReadonlyArray<
                ReadonlyArray<{
                  readonly action: string
                  readonly resource: string
                  readonly effect: "allow" | "deny" | "ask"
                }>
              >
              readonly childPermissions: ReadonlyArray<{
                readonly action: string
                readonly resource: string
                readonly effect: "allow" | "deny" | "ask"
              }>
              readonly hardPermissions: ReadonlyArray<{
                readonly action: string
                readonly resource: string
                readonly effect: "allow" | "deny" | "ask"
              }>
              readonly writeRoots: ReadonlyArray<string>
              readonly commands: ReadonlyArray<string>
              readonly orchestrate?: true
            }
            readonly result?: string
            readonly error?: string
            readonly time: {
              readonly created: number
              readonly updated: number
              readonly started?: number
              readonly completed?: number
            }
          }
          readonly operation?: {
            readonly id: string
            readonly taskID: string
            readonly rootSessionID: string
            readonly actor: {
              readonly sessionID: string
              readonly assistantMessageID: string
              readonly toolCallID: string
              readonly item?: number
            }
            readonly kind: "spawn" | "send" | "interrupt"
            readonly requestHash: string
            readonly messageID?: string
            readonly prompt?: {
              readonly text: string
              readonly parts?: ReadonlyArray<{
                readonly id: string
                readonly text: string
                readonly synthetic?: boolean
                readonly ignored?: boolean
                readonly metadata?: {
                  readonly forgeComment?: {
                    readonly path: string
                    readonly selection?: {
                      readonly startLine: number
                      readonly startChar: number
                      readonly endLine: number
                      readonly endChar: number
                    }
                    readonly comment: string
                    readonly preview?: string
                    readonly origin?: "review" | "file"
                  }
                  readonly forgeSwarm?:
                    | {
                        readonly status: "ready"
                        readonly objective: string
                        readonly count: number
                        readonly explicitCount: boolean
                      }
                    | {
                        readonly status: "invalid"
                        readonly objective: string
                        readonly reason: "missing_objective" | "count_out_of_range"
                        readonly requestedCount?: string | null
                      }
                }
              }>
              readonly files?: ReadonlyArray<{
                readonly uri: string
                readonly mime: string
                readonly name?: string
                readonly description?: string
                readonly source?: { readonly start: number; readonly end: number; readonly text: string }
              }>
              readonly agents?: ReadonlyArray<{
                readonly name: string
                readonly source?: { readonly start: number; readonly end: number; readonly text: string }
              }>
            }
            readonly status: "pending" | "applied" | "failed"
            readonly error?: string
            readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.task.operation.updated"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: { readonly directory: string; readonly workspaceID?: string }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly taskID: string
          readonly operation: {
            readonly id: string
            readonly taskID: string
            readonly rootSessionID: string
            readonly actor: {
              readonly sessionID: string
              readonly assistantMessageID: string
              readonly toolCallID: string
              readonly item?: number
            }
            readonly kind: "spawn" | "send" | "interrupt"
            readonly requestHash: string
            readonly messageID?: string
            readonly prompt?: {
              readonly text: string
              readonly parts?: ReadonlyArray<{
                readonly id: string
                readonly text: string
                readonly synthetic?: boolean
                readonly ignored?: boolean
                readonly metadata?: {
                  readonly forgeComment?: {
                    readonly path: string
                    readonly selection?: {
                      readonly startLine: number
                      readonly startChar: number
                      readonly endLine: number
                      readonly endChar: number
                    }
                    readonly comment: string
                    readonly preview?: string
                    readonly origin?: "review" | "file"
                  }
                  readonly forgeSwarm?:
                    | {
                        readonly status: "ready"
                        readonly objective: string
                        readonly count: number
                        readonly explicitCount: boolean
                      }
                    | {
                        readonly status: "invalid"
                        readonly objective: string
                        readonly reason: "missing_objective" | "count_out_of_range"
                        readonly requestedCount?: string | null
                      }
                }
              }>
              readonly files?: ReadonlyArray<{
                readonly uri: string
                readonly mime: string
                readonly name?: string
                readonly description?: string
                readonly source?: { readonly start: number; readonly end: number; readonly text: string }
              }>
              readonly agents?: ReadonlyArray<{
                readonly name: string
                readonly source?: { readonly start: number; readonly end: number; readonly text: string }
              }>
            }
            readonly status: "pending" | "applied" | "failed"
            readonly error?: string
            readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
          }
        }
      }
  >
  readonly hasMore: boolean
  readonly latest: number
}

export type SessionsReplayHistoryInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: {
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
    readonly anchor?: string | undefined
    readonly direction?: "before" | "after" | undefined
  }["limit"]
  readonly cursor?: {
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
    readonly anchor?: string | undefined
    readonly direction?: "before" | "after" | undefined
  }["cursor"]
  readonly anchor?: {
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
    readonly anchor?: string | undefined
    readonly direction?: "before" | "after" | undefined
  }["anchor"]
  readonly direction?: {
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
    readonly anchor?: string | undefined
    readonly direction?: "before" | "after" | undefined
  }["direction"]
}

export type SessionsReplayHistoryOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly type: string
    readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
    readonly data: { readonly [x: string]: unknown }
  }>
  readonly cursor: { readonly previous?: string | undefined; readonly next?: string | undefined }
}

export type SessionsEventsInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly after?: { readonly after?: number | undefined }["after"]
}

export type SessionsEventsOutput =
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.agent.switched"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly agent: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.model.switched"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.title.updated"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: { readonly timestamp: number; readonly sessionID: string; readonly title: string }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.moved"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly location: { readonly directory: string; readonly workspaceID?: string }
        readonly subdirectory?: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.prompted"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly prompt: {
          readonly text: string
          readonly parts?: ReadonlyArray<{
            readonly id: string
            readonly text: string
            readonly synthetic?: boolean
            readonly ignored?: boolean
            readonly metadata?: {
              readonly forgeComment?: {
                readonly path: string
                readonly selection?: {
                  readonly startLine: number
                  readonly startChar: number
                  readonly endLine: number
                  readonly endChar: number
                }
                readonly comment: string
                readonly preview?: string
                readonly origin?: "review" | "file"
              }
              readonly forgeSwarm?:
                | {
                    readonly status: "ready"
                    readonly objective: string
                    readonly count: number
                    readonly explicitCount: boolean
                  }
                | {
                    readonly status: "invalid"
                    readonly objective: string
                    readonly reason: "missing_objective" | "count_out_of_range"
                    readonly requestedCount?: string | undefined
                  }
            }
          }>
          readonly files?: ReadonlyArray<{
            readonly uri: string
            readonly mime: string
            readonly name?: string
            readonly description?: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
          readonly agents?: ReadonlyArray<{
            readonly name: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
        }
        readonly delivery: "steer" | "queue"
        readonly source?:
          | "user"
          | "subagent_board"
          | "subagent_settle"
          | "subagent_advisory"
          | "shell_job"
          | "swarm_room"
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.prompt.admitted"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly prompt: {
          readonly text: string
          readonly parts?: ReadonlyArray<{
            readonly id: string
            readonly text: string
            readonly synthetic?: boolean
            readonly ignored?: boolean
            readonly metadata?: {
              readonly forgeComment?: {
                readonly path: string
                readonly selection?: {
                  readonly startLine: number
                  readonly startChar: number
                  readonly endLine: number
                  readonly endChar: number
                }
                readonly comment: string
                readonly preview?: string
                readonly origin?: "review" | "file"
              }
              readonly forgeSwarm?:
                | {
                    readonly status: "ready"
                    readonly objective: string
                    readonly count: number
                    readonly explicitCount: boolean
                  }
                | {
                    readonly status: "invalid"
                    readonly objective: string
                    readonly reason: "missing_objective" | "count_out_of_range"
                    readonly requestedCount?: string | undefined
                  }
            }
          }>
          readonly files?: ReadonlyArray<{
            readonly uri: string
            readonly mime: string
            readonly name?: string
            readonly description?: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
          readonly agents?: ReadonlyArray<{
            readonly name: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
        }
        readonly delivery: "steer" | "queue"
        readonly source?:
          | "user"
          | "subagent_board"
          | "subagent_settle"
          | "subagent_advisory"
          | "shell_job"
          | "swarm_room"
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly command?: {
          readonly command: string
          readonly arguments: string
          readonly agent?: string
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          readonly files?: ReadonlyArray<{
            readonly uri: string
            readonly name?: string
            readonly description?: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
        }
        readonly revert?: { readonly messageID: string }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.context.updated"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.synthetic"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.shell.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly callID: string
        readonly command: string
        readonly timeout?: number
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.shell.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly callID: string
        readonly output: string
        readonly status: "completed" | "cancelled" | "timed_out" | "failed"
        readonly exitCode?: number
        readonly truncated?: boolean
        readonly error?: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.step.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly snapshot?: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.step.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly finish: string
        readonly cost: number
        readonly tokens: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly billed?: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly snapshot?: string
        readonly files?: ReadonlyArray<string>
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.step.failed"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly error: { readonly type: "unknown"; readonly message: string }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.text.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly textID: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.text.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly textID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.input.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly name: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.input.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.called"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly tool: string
        readonly input: { readonly [x: string]: unknown }
        readonly provider: {
          readonly executed: boolean
          readonly metadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.progress"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly structured: { readonly [x: string]: unknown }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly text: string }
          | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
        >
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.success"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly structured: { readonly [x: string]: unknown }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly text: string }
          | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
        >
        readonly outputPaths?: ReadonlyArray<string>
        readonly result?: unknown
        readonly provider: {
          readonly executed: boolean
          readonly metadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.failed"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly error: { readonly type: "unknown"; readonly message: string }
        readonly result?: unknown
        readonly provider: {
          readonly executed: boolean
          readonly metadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.reasoning.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly reasoningID: string
        readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.reasoning.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly reasoningID: string
        readonly text: string
        readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.harness.proposal.created"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly proposal: {
          readonly id: string
          readonly baseVersion: number
          readonly summary: string
          readonly changes: ReadonlyArray<{
            readonly path: string
            readonly operation: "add" | "modify" | "delete"
            readonly summary?: string
            readonly patch?: string
            readonly content?: string
          }>
          readonly tools?: ReadonlyArray<{
            readonly name: string
            readonly description: string
            readonly source?: string
            readonly readOnly: boolean
            readonly enabled: boolean
          }>
          readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
          readonly status: "draft" | "pending" | "approved" | "applied" | "rejected" | "failed"
          readonly appliedVersion?: number
          readonly validation: {
            readonly status: "pending" | "passed" | "failed"
            readonly errors: ReadonlyArray<string>
            readonly warnings: ReadonlyArray<string>
          }
          readonly timestamps: { readonly created: number; readonly updated: number }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.harness.proposal.status"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly proposalID: string
        readonly status: "draft" | "pending" | "approved" | "applied" | "rejected" | "failed"
        readonly validation?: {
          readonly status: "pending" | "passed" | "failed"
          readonly errors: ReadonlyArray<string>
          readonly warnings: ReadonlyArray<string>
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.harness.snapshot.created"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly proposalID?: string
        readonly snapshot: {
          readonly version: number
          readonly parent?: number
          readonly status: "active" | "superseded" | "rolledBack"
          readonly source: "default" | "proposal" | "reload" | "rollback"
          readonly changes: ReadonlyArray<{
            readonly path: string
            readonly operation: "add" | "modify" | "delete"
            readonly summary?: string
            readonly patch?: string
            readonly content?: string
          }>
          readonly tools: ReadonlyArray<{
            readonly name: string
            readonly description: string
            readonly source?: string
            readonly readOnly: boolean
            readonly enabled: boolean
          }>
          readonly guidance?: ReadonlyArray<{ readonly directive: string; readonly appliesTo?: string }>
          readonly validation: {
            readonly status: "pending" | "passed" | "failed"
            readonly errors: ReadonlyArray<string>
            readonly warnings: ReadonlyArray<string>
          }
          readonly timestamps: { readonly created: number; readonly updated: number }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.harness.reloaded"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: { readonly timestamp: number; readonly sessionID: string; readonly version: number }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.retried"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly attempt: number
        readonly delay: number
        readonly error: {
          readonly message: string
          readonly statusCode?: number
          readonly isRetryable: boolean
          readonly responseHeaders?: { readonly [x: string]: string }
          readonly responseBody?: string
          readonly metadata?: { readonly [x: string]: string }
        }
        readonly action?: {
          readonly reason: string
          readonly provider: string
          readonly title: string
          readonly message: string
          readonly label: string
          readonly link?: string
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.compaction.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly reason: "auto" | "manual"
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.compaction.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly reason: "auto" | "manual"
        readonly text: string
        readonly recent: string
        readonly ledger?: ReadonlyArray<string>
        readonly throughSeq?: number
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.compaction.failed"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly mode: "auto" | "manual"
        readonly reason: string
        readonly detail?: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.compaction.pruned"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly entries: ReadonlyArray<{ readonly assistantMessageID: string; readonly callID: string }>
        readonly freed: number
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.revert.staged"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly revert: {
          readonly messageID: string
          readonly partID?: string
          readonly snapshot?: string
          readonly diff?: string
          readonly files?: ReadonlyArray<{
            readonly path: string
            readonly status: "added" | "modified" | "deleted"
            readonly additions: number
            readonly deletions: number
            readonly patch: string
          }>
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.revert.cleared"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: { readonly timestamp: number; readonly sessionID: string }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.revert.committed"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: { readonly timestamp: number; readonly sessionID: string; readonly messageID: string }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.goal.updated"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly goal: {
          readonly id: string
          readonly sessionID: string
          readonly revision: number
          readonly objective: string
          readonly status: "active" | "paused" | "blocked" | "usageLimited" | "complete"
          readonly tokensUsed: number
          readonly timeUsedSeconds: number
          readonly time: {
            readonly created: number
            readonly updated: number
            readonly statusChanged: number
            readonly completed?: number
          }
        }
        readonly activeTimeMs: number
        readonly admission?: {
          readonly messageID: string
          readonly prompt: {
            readonly text: string
            readonly parts?: ReadonlyArray<{
              readonly id: string
              readonly text: string
              readonly synthetic?: boolean
              readonly ignored?: boolean
              readonly metadata?: {
                readonly forgeComment?: {
                  readonly path: string
                  readonly selection?: {
                    readonly startLine: number
                    readonly startChar: number
                    readonly endLine: number
                    readonly endChar: number
                  }
                  readonly comment: string
                  readonly preview?: string
                  readonly origin?: "review" | "file"
                }
                readonly forgeSwarm?:
                  | {
                      readonly status: "ready"
                      readonly objective: string
                      readonly count: number
                      readonly explicitCount: boolean
                    }
                  | {
                      readonly status: "invalid"
                      readonly objective: string
                      readonly reason: "missing_objective" | "count_out_of_range"
                      readonly requestedCount?: string | undefined
                    }
              }
            }>
            readonly files?: ReadonlyArray<{
              readonly uri: string
              readonly mime: string
              readonly name?: string
              readonly description?: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly agents?: ReadonlyArray<{
              readonly name: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
          }
          readonly delivery: "steer" | "queue"
          readonly agent?: string
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          readonly revert?: { readonly messageID: string }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.goal.cleared"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly goalID: string
        readonly revision: number
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.task.updated"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly taskID: string
        readonly task: {
          readonly id: string
          readonly rootSessionID: string
          readonly parentSessionID: string
          readonly childSessionID: string
          readonly parentTaskID?: string
          readonly actor: {
            readonly sessionID: string
            readonly assistantMessageID: string
            readonly toolCallID: string
            readonly item?: number
          }
          readonly agent: string
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
          readonly prompt: {
            readonly text: string
            readonly parts?: ReadonlyArray<{
              readonly id: string
              readonly text: string
              readonly synthetic?: boolean
              readonly ignored?: boolean
              readonly metadata?: {
                readonly forgeComment?: {
                  readonly path: string
                  readonly selection?: {
                    readonly startLine: number
                    readonly startChar: number
                    readonly endLine: number
                    readonly endChar: number
                  }
                  readonly comment: string
                  readonly preview?: string
                  readonly origin?: "review" | "file"
                }
                readonly forgeSwarm?:
                  | {
                      readonly status: "ready"
                      readonly objective: string
                      readonly count: number
                      readonly explicitCount: boolean
                    }
                  | {
                      readonly status: "invalid"
                      readonly objective: string
                      readonly reason: "missing_objective" | "count_out_of_range"
                      readonly requestedCount?: string | undefined
                    }
              }
            }>
            readonly files?: ReadonlyArray<{
              readonly uri: string
              readonly mime: string
              readonly name?: string
              readonly description?: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly agents?: ReadonlyArray<{
              readonly name: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
          }
          readonly description: string
          readonly wave?: string
          readonly depth: number
          readonly status: "queued" | "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted"
          readonly revision: number
          readonly authority: {
            readonly parentPermissions: ReadonlyArray<{
              readonly action: string
              readonly resource: string
              readonly effect: "allow" | "deny" | "ask"
            }>
            readonly ancestorPermissionSets: ReadonlyArray<
              ReadonlyArray<{
                readonly action: string
                readonly resource: string
                readonly effect: "allow" | "deny" | "ask"
              }>
            >
            readonly childPermissions: ReadonlyArray<{
              readonly action: string
              readonly resource: string
              readonly effect: "allow" | "deny" | "ask"
            }>
            readonly hardPermissions: ReadonlyArray<{
              readonly action: string
              readonly resource: string
              readonly effect: "allow" | "deny" | "ask"
            }>
            readonly writeRoots: ReadonlyArray<string>
            readonly commands: ReadonlyArray<string>
            readonly orchestrate?: true
          }
          readonly result?: string
          readonly error?: string
          readonly time: {
            readonly created: number
            readonly updated: number
            readonly started?: number
            readonly completed?: number
          }
        }
        readonly operation?: {
          readonly id: string
          readonly taskID: string
          readonly rootSessionID: string
          readonly actor: {
            readonly sessionID: string
            readonly assistantMessageID: string
            readonly toolCallID: string
            readonly item?: number
          }
          readonly kind: "spawn" | "send" | "interrupt"
          readonly requestHash: string
          readonly messageID?: string
          readonly prompt?: {
            readonly text: string
            readonly parts?: ReadonlyArray<{
              readonly id: string
              readonly text: string
              readonly synthetic?: boolean
              readonly ignored?: boolean
              readonly metadata?: {
                readonly forgeComment?: {
                  readonly path: string
                  readonly selection?: {
                    readonly startLine: number
                    readonly startChar: number
                    readonly endLine: number
                    readonly endChar: number
                  }
                  readonly comment: string
                  readonly preview?: string
                  readonly origin?: "review" | "file"
                }
                readonly forgeSwarm?:
                  | {
                      readonly status: "ready"
                      readonly objective: string
                      readonly count: number
                      readonly explicitCount: boolean
                    }
                  | {
                      readonly status: "invalid"
                      readonly objective: string
                      readonly reason: "missing_objective" | "count_out_of_range"
                      readonly requestedCount?: string | undefined
                    }
              }
            }>
            readonly files?: ReadonlyArray<{
              readonly uri: string
              readonly mime: string
              readonly name?: string
              readonly description?: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly agents?: ReadonlyArray<{
              readonly name: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
          }
          readonly status: "pending" | "applied" | "failed"
          readonly error?: string
          readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.task.operation.updated"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly taskID: string
        readonly operation: {
          readonly id: string
          readonly taskID: string
          readonly rootSessionID: string
          readonly actor: {
            readonly sessionID: string
            readonly assistantMessageID: string
            readonly toolCallID: string
            readonly item?: number
          }
          readonly kind: "spawn" | "send" | "interrupt"
          readonly requestHash: string
          readonly messageID?: string
          readonly prompt?: {
            readonly text: string
            readonly parts?: ReadonlyArray<{
              readonly id: string
              readonly text: string
              readonly synthetic?: boolean
              readonly ignored?: boolean
              readonly metadata?: {
                readonly forgeComment?: {
                  readonly path: string
                  readonly selection?: {
                    readonly startLine: number
                    readonly startChar: number
                    readonly endLine: number
                    readonly endChar: number
                  }
                  readonly comment: string
                  readonly preview?: string
                  readonly origin?: "review" | "file"
                }
                readonly forgeSwarm?:
                  | {
                      readonly status: "ready"
                      readonly objective: string
                      readonly count: number
                      readonly explicitCount: boolean
                    }
                  | {
                      readonly status: "invalid"
                      readonly objective: string
                      readonly reason: "missing_objective" | "count_out_of_range"
                      readonly requestedCount?: string | undefined
                    }
              }
            }>
            readonly files?: ReadonlyArray<{
              readonly uri: string
              readonly mime: string
              readonly name?: string
              readonly description?: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly agents?: ReadonlyArray<{
              readonly name: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
          }
          readonly status: "pending" | "applied" | "failed"
          readonly error?: string
          readonly time: { readonly created: number; readonly updated: number; readonly completed?: number }
        }
      }
    }

export type SessionsInterruptInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsInterruptOutput = void

export type SessionsMessageInput = {
  readonly sessionID: { readonly sessionID: string; readonly messageID: string }["sessionID"]
  readonly messageID: { readonly sessionID: string; readonly messageID: string }["messageID"]
}

export type SessionsMessageOutput = {
  readonly data:
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "agent-switched"
        readonly agent: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "model-switched"
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly source?:
          | "user"
          | "subagent_board"
          | "subagent_settle"
          | "subagent_advisory"
          | "shell_job"
          | "swarm_room"
        readonly text: string
        readonly parts?: ReadonlyArray<{
          readonly id: string
          readonly text: string
          readonly synthetic?: boolean
          readonly ignored?: boolean
          readonly metadata?: {
            readonly forgeComment?: {
              readonly path: string
              readonly selection?: {
                readonly startLine: number
                readonly startChar: number
                readonly endLine: number
                readonly endChar: number
              }
              readonly comment: string
              readonly preview?: string
              readonly origin?: "review" | "file"
            }
            readonly forgeSwarm?:
              | {
                  readonly status: "ready"
                  readonly objective: string
                  readonly count: number
                  readonly explicitCount: boolean
                }
              | {
                  readonly status: "invalid"
                  readonly objective: string
                  readonly reason: "missing_objective" | "count_out_of_range"
                  readonly requestedCount?: string | null
                }
          }
        }>
        readonly files?: ReadonlyArray<{
          readonly uri: string
          readonly mime: string
          readonly name?: string
          readonly description?: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly agents?: ReadonlyArray<{
          readonly name: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly type: "user"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly sessionID: string
        readonly text: string
        readonly type: "synthetic"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "system"
        readonly text: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "shell"
        readonly callID: string
        readonly command: string
        readonly timeout?: number
        readonly output: string
        readonly status?: "running" | "completed" | "cancelled" | "timed_out" | "failed"
        readonly exitCode?: number
        readonly truncated?: boolean
        readonly error?: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "assistant"
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly id: string; readonly text: string }
          | {
              readonly type: "reasoning"
              readonly id: string
              readonly text: string
              readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              readonly time?: { readonly created: number; readonly completed?: number }
            }
          | {
              readonly type: "tool"
              readonly id: string
              readonly name: string
              readonly truncated?: { readonly bytes: number }
              readonly provider?: {
                readonly executed: boolean
                readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
                readonly resultMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              }
              readonly state:
                | { readonly status: "pending"; readonly input: string }
                | {
                    readonly status: "running"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                  }
                | {
                    readonly status: "completed"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly attachments?: ReadonlyArray<{
                      readonly uri: string
                      readonly mime: string
                      readonly name?: string
                      readonly description?: string
                      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
                    }>
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly outputPaths?: ReadonlyArray<string>
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly result?: JsonValue
                  }
                | {
                    readonly status: "error"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly error: { readonly type: "unknown"; readonly message: string }
                    readonly result?: JsonValue
                  }
              readonly time: {
                readonly created: number
                readonly ran?: number
                readonly completed?: number
                readonly pruned?: number
              }
            }
        >
        readonly snapshot?: { readonly start?: string; readonly end?: string; readonly files?: ReadonlyArray<string> }
        readonly finish?: string
        readonly cost?: number
        readonly tokens?: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly error?: { readonly type: "unknown"; readonly message: string }
      }
    | {
        readonly type: "compaction"
        readonly reason: "auto" | "manual"
        readonly summary: string
        readonly recent: string
        readonly ledger?: ReadonlyArray<string>
        readonly throughSeq?: number
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
      }
}["data"]

export type MessagesListInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: {
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly cursor?: string | undefined
    readonly lean?: boolean | undefined
  }["limit"]
  readonly order?: {
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly cursor?: string | undefined
    readonly lean?: boolean | undefined
  }["order"]
  readonly cursor?: {
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly cursor?: string | undefined
    readonly lean?: boolean | undefined
  }["cursor"]
  readonly lean?: {
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly cursor?: string | undefined
    readonly lean?: boolean | undefined
  }["lean"]
}

export type MessagesListOutput = {
  readonly data: ReadonlyArray<
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "agent-switched"
        readonly agent: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "model-switched"
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly source?:
          | "user"
          | "subagent_board"
          | "subagent_settle"
          | "subagent_advisory"
          | "shell_job"
          | "swarm_room"
        readonly text: string
        readonly parts?: ReadonlyArray<{
          readonly id: string
          readonly text: string
          readonly synthetic?: boolean
          readonly ignored?: boolean
          readonly metadata?: {
            readonly forgeComment?: {
              readonly path: string
              readonly selection?: {
                readonly startLine: number
                readonly startChar: number
                readonly endLine: number
                readonly endChar: number
              }
              readonly comment: string
              readonly preview?: string
              readonly origin?: "review" | "file"
            }
            readonly forgeSwarm?:
              | {
                  readonly status: "ready"
                  readonly objective: string
                  readonly count: number
                  readonly explicitCount: boolean
                }
              | {
                  readonly status: "invalid"
                  readonly objective: string
                  readonly reason: "missing_objective" | "count_out_of_range"
                  readonly requestedCount?: string | null
                }
          }
        }>
        readonly files?: ReadonlyArray<{
          readonly uri: string
          readonly mime: string
          readonly name?: string
          readonly description?: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly agents?: ReadonlyArray<{
          readonly name: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly type: "user"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly sessionID: string
        readonly text: string
        readonly type: "synthetic"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "system"
        readonly text: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "shell"
        readonly callID: string
        readonly command: string
        readonly timeout?: number
        readonly output: string
        readonly status?: "running" | "completed" | "cancelled" | "timed_out" | "failed"
        readonly exitCode?: number
        readonly truncated?: boolean
        readonly error?: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "assistant"
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly id: string; readonly text: string }
          | {
              readonly type: "reasoning"
              readonly id: string
              readonly text: string
              readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              readonly time?: { readonly created: number; readonly completed?: number }
            }
          | {
              readonly type: "tool"
              readonly id: string
              readonly name: string
              readonly truncated?: { readonly bytes: number }
              readonly provider?: {
                readonly executed: boolean
                readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
                readonly resultMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              }
              readonly state:
                | { readonly status: "pending"; readonly input: string }
                | {
                    readonly status: "running"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                  }
                | {
                    readonly status: "completed"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly attachments?: ReadonlyArray<{
                      readonly uri: string
                      readonly mime: string
                      readonly name?: string
                      readonly description?: string
                      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
                    }>
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly outputPaths?: ReadonlyArray<string>
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly result?: JsonValue
                  }
                | {
                    readonly status: "error"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly error: { readonly type: "unknown"; readonly message: string }
                    readonly result?: JsonValue
                  }
              readonly time: {
                readonly created: number
                readonly ran?: number
                readonly completed?: number
                readonly pruned?: number
              }
            }
        >
        readonly snapshot?: { readonly start?: string; readonly end?: string; readonly files?: ReadonlyArray<string> }
        readonly finish?: string
        readonly cost?: number
        readonly tokens?: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly error?: { readonly type: "unknown"; readonly message: string }
      }
    | {
        readonly type: "compaction"
        readonly reason: "auto" | "manual"
        readonly summary: string
        readonly recent: string
        readonly ledger?: ReadonlyArray<string>
        readonly throughSeq?: number
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
      }
  >
  readonly cursor: { readonly previous?: string | null; readonly next?: string | null }
}

export type PermissionsListRequestsInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type PermissionsListRequestsOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
  }>
}

export type PermissionsListSavedInput = {
  readonly projectID?: { readonly projectID?: string | undefined }["projectID"]
}

export type PermissionsListSavedOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly projectID: string
    readonly action: string
    readonly resource: string
  }>
}["data"]

export type PermissionsRemoveSavedInput = { readonly id: { readonly id: string }["id"] }

export type PermissionsRemoveSavedOutput = void

export type PermissionsCreateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["id"]
  readonly action: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["action"]
  readonly resources: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["resources"]
  readonly save?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["save"]
  readonly metadata?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["metadata"]
  readonly source?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["source"]
  readonly agent?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["agent"]
}

export type PermissionsCreateOutput = {
  readonly data: { readonly id: string; readonly effect: "allow" | "deny" | "ask" }
}["data"]

export type PermissionsListInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type PermissionsListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
  }>
}["data"]

export type PermissionsGetInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
}

export type PermissionsGetOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
  }
}["data"]

export type PermissionsReplyInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
  readonly reply: { readonly reply: "once" | "always" | "reject"; readonly message?: string | undefined }["reply"]
  readonly message?: { readonly reply: "once" | "always" | "reject"; readonly message?: string | undefined }["message"]
}

export type PermissionsReplyOutput = void

export type FilesListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly path?: string | undefined
  }["location"]
  readonly path?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly path?: string | undefined
  }["path"]
}

export type FilesListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{ readonly path: string; readonly type: "file" | "directory" }>
}

export type FilesFindInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly query: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["query"]
  readonly type?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["type"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type FilesFindOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{ readonly path: string; readonly type: "file" | "directory" }>
}

export type CommandsListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type CommandsListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly name: string
    readonly template: string
    readonly description?: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly subtask?: boolean
  }>
}

export type EventsSubscribeOutput = ForgeEventEncoded

export type PtysListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type PtysListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
  }>
}

export type PtysCreateInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly command?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["command"]
  readonly args?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["args"]
  readonly cwd?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["cwd"]
  readonly title?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["title"]
  readonly env?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["env"]
}

export type PtysCreateOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
  }
}

export type PtysGetInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type PtysGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
  }
}

export type PtysUpdateInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly title?: {
    readonly title?: string
    readonly size?: { readonly rows: number; readonly cols: number }
  }["title"]
  readonly size?: { readonly title?: string; readonly size?: { readonly rows: number; readonly cols: number } }["size"]
}

export type PtysUpdateOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
  }
}

export type PtysRemoveInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type PtysRemoveOutput = void

export type QuestionsListRequestsInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type QuestionsListRequestsOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly questions: ReadonlyArray<{
      readonly question: string
      readonly header: string
      readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
      readonly multiple?: boolean
      readonly custom?: boolean
    }>
    readonly tool?: { readonly messageID: string; readonly callID: string }
  }>
}

export type QuestionsListInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type QuestionsListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly questions: ReadonlyArray<{
      readonly question: string
      readonly header: string
      readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
      readonly multiple?: boolean
      readonly custom?: boolean
    }>
    readonly tool?: { readonly messageID: string; readonly callID: string }
  }>
}["data"]

export type QuestionsReplyInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
  readonly answers: { readonly answers: ReadonlyArray<ReadonlyArray<string>> }["answers"]
}

export type QuestionsReplyOutput = void

export type QuestionsRejectInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
}

export type QuestionsRejectOutput = void

export type ProjectCopiesCreateInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly strategy: { readonly strategy: string; readonly directory: string; readonly name?: string }["strategy"]
  readonly directory: { readonly strategy: string; readonly directory: string; readonly name?: string }["directory"]
  readonly name?: { readonly strategy: string; readonly directory: string; readonly name?: string }["name"]
}

export type ProjectCopiesCreateOutput = { readonly directory: string }

export type ProjectCopiesRemoveInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
  readonly directory: { readonly directory: string; readonly force: boolean }["directory"]
  readonly force: { readonly directory: string; readonly force: boolean }["force"]
}

export type ProjectCopiesRemoveOutput = void

export type ProjectCopiesRefreshInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
  }["location"]
}

export type ProjectCopiesRefreshOutput = void

export type MemoriesWingsOutput = ReadonlyArray<{
  readonly id: string
  readonly kind: "project" | "person" | "engagement"
  readonly key: string
  readonly name: string
  readonly timeCreated: number
  readonly timeUpdated: number
}>

export type MemoriesWingInput = {
  readonly kind: {
    readonly kind: "project" | "person" | "engagement"
    readonly key: string
    readonly name: string
  }["kind"]
  readonly key: {
    readonly kind: "project" | "person" | "engagement"
    readonly key: string
    readonly name: string
  }["key"]
  readonly name: {
    readonly kind: "project" | "person" | "engagement"
    readonly key: string
    readonly name: string
  }["name"]
}

export type MemoriesWingOutput = {
  readonly id: string
  readonly kind: "project" | "person" | "engagement"
  readonly key: string
  readonly name: string
  readonly timeCreated: number
  readonly timeUpdated: number
}

export type MemoriesRoomsInput = { readonly wingID: { readonly wingID: string }["wingID"] }

export type MemoriesRoomsOutput = ReadonlyArray<{
  readonly id: string
  readonly wingID: string
  readonly slug: string
  readonly name: string
  readonly timeCreated: number
  readonly timeUpdated: number
}>

export type MemoriesRoomInput = {
  readonly wingID: { readonly wingID: string; readonly slug: string; readonly name: string }["wingID"]
  readonly slug: { readonly wingID: string; readonly slug: string; readonly name: string }["slug"]
  readonly name: { readonly wingID: string; readonly slug: string; readonly name: string }["name"]
}

export type MemoriesRoomOutput = {
  readonly id: string
  readonly wingID: string
  readonly slug: string
  readonly name: string
  readonly timeCreated: number
  readonly timeUpdated: number
}

export type MemoriesListInput = {
  readonly wingID: { readonly wingID: string; readonly roomID?: string | undefined }["wingID"]
  readonly roomID?: { readonly wingID: string; readonly roomID?: string | undefined }["roomID"]
}

export type MemoriesListOutput = ReadonlyArray<{
  readonly id: string
  readonly wingID: string
  readonly roomID: string
  readonly kind: "note" | "fact" | "decision" | "observation"
  readonly title: string
  readonly body: string
  readonly anchor: {
    readonly repo?: string
    readonly path?: string
    readonly commit?: string
    readonly symbol?: string
  }
  readonly provenance: {
    readonly assertedBy: string
    readonly source: "agent" | "human" | "import"
    readonly sessionID?: string
    readonly commit?: string
  }
  readonly timeValidFrom: number | "Infinity" | "-Infinity" | "NaN"
  readonly timeValidUntil?: number | "Infinity" | "-Infinity" | "NaN"
  readonly supersededBy?: string
  readonly timeCreated: number | "Infinity" | "-Infinity" | "NaN"
  readonly timeUpdated: number | "Infinity" | "-Infinity" | "NaN"
}>

export type MemoriesCreateInput = {
  readonly wingID: {
    readonly wingID: string
    readonly roomID: string
    readonly kind: "note" | "fact" | "decision" | "observation"
    readonly title: string
    readonly body: string
    readonly anchor?: {
      readonly repo?: string
      readonly path?: string
      readonly commit?: string
      readonly symbol?: string
    }
    readonly validFrom?: number | "Infinity" | "-Infinity" | "NaN"
    readonly supersedes?: string
  }["wingID"]
  readonly roomID: {
    readonly wingID: string
    readonly roomID: string
    readonly kind: "note" | "fact" | "decision" | "observation"
    readonly title: string
    readonly body: string
    readonly anchor?: {
      readonly repo?: string
      readonly path?: string
      readonly commit?: string
      readonly symbol?: string
    }
    readonly validFrom?: number | "Infinity" | "-Infinity" | "NaN"
    readonly supersedes?: string
  }["roomID"]
  readonly kind: {
    readonly wingID: string
    readonly roomID: string
    readonly kind: "note" | "fact" | "decision" | "observation"
    readonly title: string
    readonly body: string
    readonly anchor?: {
      readonly repo?: string
      readonly path?: string
      readonly commit?: string
      readonly symbol?: string
    }
    readonly validFrom?: number | "Infinity" | "-Infinity" | "NaN"
    readonly supersedes?: string
  }["kind"]
  readonly title: {
    readonly wingID: string
    readonly roomID: string
    readonly kind: "note" | "fact" | "decision" | "observation"
    readonly title: string
    readonly body: string
    readonly anchor?: {
      readonly repo?: string
      readonly path?: string
      readonly commit?: string
      readonly symbol?: string
    }
    readonly validFrom?: number | "Infinity" | "-Infinity" | "NaN"
    readonly supersedes?: string
  }["title"]
  readonly body: {
    readonly wingID: string
    readonly roomID: string
    readonly kind: "note" | "fact" | "decision" | "observation"
    readonly title: string
    readonly body: string
    readonly anchor?: {
      readonly repo?: string
      readonly path?: string
      readonly commit?: string
      readonly symbol?: string
    }
    readonly validFrom?: number | "Infinity" | "-Infinity" | "NaN"
    readonly supersedes?: string
  }["body"]
  readonly anchor?: {
    readonly wingID: string
    readonly roomID: string
    readonly kind: "note" | "fact" | "decision" | "observation"
    readonly title: string
    readonly body: string
    readonly anchor?: {
      readonly repo?: string
      readonly path?: string
      readonly commit?: string
      readonly symbol?: string
    }
    readonly validFrom?: number | "Infinity" | "-Infinity" | "NaN"
    readonly supersedes?: string
  }["anchor"]
  readonly validFrom?: {
    readonly wingID: string
    readonly roomID: string
    readonly kind: "note" | "fact" | "decision" | "observation"
    readonly title: string
    readonly body: string
    readonly anchor?: {
      readonly repo?: string
      readonly path?: string
      readonly commit?: string
      readonly symbol?: string
    }
    readonly validFrom?: number | "Infinity" | "-Infinity" | "NaN"
    readonly supersedes?: string
  }["validFrom"]
  readonly supersedes?: {
    readonly wingID: string
    readonly roomID: string
    readonly kind: "note" | "fact" | "decision" | "observation"
    readonly title: string
    readonly body: string
    readonly anchor?: {
      readonly repo?: string
      readonly path?: string
      readonly commit?: string
      readonly symbol?: string
    }
    readonly validFrom?: number | "Infinity" | "-Infinity" | "NaN"
    readonly supersedes?: string
  }["supersedes"]
}

export type MemoriesCreateOutput = {
  readonly id: string
  readonly wingID: string
  readonly roomID: string
  readonly kind: "note" | "fact" | "decision" | "observation"
  readonly title: string
  readonly body: string
  readonly anchor: {
    readonly repo?: string
    readonly path?: string
    readonly commit?: string
    readonly symbol?: string
  }
  readonly provenance: {
    readonly assertedBy: string
    readonly source: "agent" | "human" | "import"
    readonly sessionID?: string
    readonly commit?: string
  }
  readonly timeValidFrom: number | "Infinity" | "-Infinity" | "NaN"
  readonly timeValidUntil?: number | "Infinity" | "-Infinity" | "NaN"
  readonly supersededBy?: string
  readonly timeCreated: number | "Infinity" | "-Infinity" | "NaN"
  readonly timeUpdated: number | "Infinity" | "-Infinity" | "NaN"
}

export type MemoriesUpdateInput = {
  readonly drawerID: { readonly drawerID: string }["drawerID"]
  readonly expectedTimeUpdated: {
    readonly expectedTimeUpdated: number | "Infinity" | "-Infinity" | "NaN"
    readonly wingID: string
    readonly roomID: string
    readonly kind: "note" | "fact" | "decision" | "observation"
    readonly title: string
    readonly body: string
    readonly anchor?: {
      readonly repo?: string
      readonly path?: string
      readonly commit?: string
      readonly symbol?: string
    }
  }["expectedTimeUpdated"]
  readonly wingID: {
    readonly expectedTimeUpdated: number | "Infinity" | "-Infinity" | "NaN"
    readonly wingID: string
    readonly roomID: string
    readonly kind: "note" | "fact" | "decision" | "observation"
    readonly title: string
    readonly body: string
    readonly anchor?: {
      readonly repo?: string
      readonly path?: string
      readonly commit?: string
      readonly symbol?: string
    }
  }["wingID"]
  readonly roomID: {
    readonly expectedTimeUpdated: number | "Infinity" | "-Infinity" | "NaN"
    readonly wingID: string
    readonly roomID: string
    readonly kind: "note" | "fact" | "decision" | "observation"
    readonly title: string
    readonly body: string
    readonly anchor?: {
      readonly repo?: string
      readonly path?: string
      readonly commit?: string
      readonly symbol?: string
    }
  }["roomID"]
  readonly kind: {
    readonly expectedTimeUpdated: number | "Infinity" | "-Infinity" | "NaN"
    readonly wingID: string
    readonly roomID: string
    readonly kind: "note" | "fact" | "decision" | "observation"
    readonly title: string
    readonly body: string
    readonly anchor?: {
      readonly repo?: string
      readonly path?: string
      readonly commit?: string
      readonly symbol?: string
    }
  }["kind"]
  readonly title: {
    readonly expectedTimeUpdated: number | "Infinity" | "-Infinity" | "NaN"
    readonly wingID: string
    readonly roomID: string
    readonly kind: "note" | "fact" | "decision" | "observation"
    readonly title: string
    readonly body: string
    readonly anchor?: {
      readonly repo?: string
      readonly path?: string
      readonly commit?: string
      readonly symbol?: string
    }
  }["title"]
  readonly body: {
    readonly expectedTimeUpdated: number | "Infinity" | "-Infinity" | "NaN"
    readonly wingID: string
    readonly roomID: string
    readonly kind: "note" | "fact" | "decision" | "observation"
    readonly title: string
    readonly body: string
    readonly anchor?: {
      readonly repo?: string
      readonly path?: string
      readonly commit?: string
      readonly symbol?: string
    }
  }["body"]
  readonly anchor?: {
    readonly expectedTimeUpdated: number | "Infinity" | "-Infinity" | "NaN"
    readonly wingID: string
    readonly roomID: string
    readonly kind: "note" | "fact" | "decision" | "observation"
    readonly title: string
    readonly body: string
    readonly anchor?: {
      readonly repo?: string
      readonly path?: string
      readonly commit?: string
      readonly symbol?: string
    }
  }["anchor"]
}

export type MemoriesUpdateOutput = {
  readonly id: string
  readonly wingID: string
  readonly roomID: string
  readonly kind: "note" | "fact" | "decision" | "observation"
  readonly title: string
  readonly body: string
  readonly anchor: {
    readonly repo?: string
    readonly path?: string
    readonly commit?: string
    readonly symbol?: string
  }
  readonly provenance: {
    readonly assertedBy: string
    readonly source: "agent" | "human" | "import"
    readonly sessionID?: string
    readonly commit?: string
  }
  readonly timeValidFrom: number | "Infinity" | "-Infinity" | "NaN"
  readonly timeValidUntil?: number | "Infinity" | "-Infinity" | "NaN"
  readonly supersededBy?: string
  readonly timeCreated: number | "Infinity" | "-Infinity" | "NaN"
  readonly timeUpdated: number | "Infinity" | "-Infinity" | "NaN"
}

export type MemoriesRemoveInput = {
  readonly drawerID: { readonly drawerID: string }["drawerID"]
  readonly wingID: { readonly wingID: string }["wingID"]
}

export type MemoriesRemoveOutput = void

export type LoopsCreateInput = {
  readonly name: {
    readonly name: string
    readonly prompt: string
    readonly location?: { readonly directory: string; readonly workspaceID?: string | null } | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly startsAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly paused?: boolean | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
  }["name"]
  readonly prompt: {
    readonly name: string
    readonly prompt: string
    readonly location?: { readonly directory: string; readonly workspaceID?: string | null } | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly startsAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly paused?: boolean | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
  }["prompt"]
  readonly location?: {
    readonly name: string
    readonly prompt: string
    readonly location?: { readonly directory: string; readonly workspaceID?: string | null } | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly startsAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly paused?: boolean | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
  }["location"]
  readonly agent?: {
    readonly name: string
    readonly prompt: string
    readonly location?: { readonly directory: string; readonly workspaceID?: string | null } | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly startsAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly paused?: boolean | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
  }["agent"]
  readonly model?: {
    readonly name: string
    readonly prompt: string
    readonly location?: { readonly directory: string; readonly workspaceID?: string | null } | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly startsAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly paused?: boolean | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
  }["model"]
  readonly skill?: {
    readonly name: string
    readonly prompt: string
    readonly location?: { readonly directory: string; readonly workspaceID?: string | null } | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly startsAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly paused?: boolean | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
  }["skill"]
  readonly workflow?: {
    readonly name: string
    readonly prompt: string
    readonly location?: { readonly directory: string; readonly workspaceID?: string | null } | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly startsAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly paused?: boolean | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
  }["workflow"]
  readonly intervalSeconds?: {
    readonly name: string
    readonly prompt: string
    readonly location?: { readonly directory: string; readonly workspaceID?: string | null } | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly startsAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly paused?: boolean | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
  }["intervalSeconds"]
  readonly cronExpression?: {
    readonly name: string
    readonly prompt: string
    readonly location?: { readonly directory: string; readonly workspaceID?: string | null } | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly startsAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly paused?: boolean | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
  }["cronExpression"]
  readonly timezone?: {
    readonly name: string
    readonly prompt: string
    readonly location?: { readonly directory: string; readonly workspaceID?: string | null } | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly startsAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly paused?: boolean | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
  }["timezone"]
  readonly startsAt?: {
    readonly name: string
    readonly prompt: string
    readonly location?: { readonly directory: string; readonly workspaceID?: string | null } | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly startsAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly paused?: boolean | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
  }["startsAt"]
  readonly expiresAt?: {
    readonly name: string
    readonly prompt: string
    readonly location?: { readonly directory: string; readonly workspaceID?: string | null } | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly startsAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly paused?: boolean | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
  }["expiresAt"]
  readonly paused?: {
    readonly name: string
    readonly prompt: string
    readonly location?: { readonly directory: string; readonly workspaceID?: string | null } | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly startsAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly paused?: boolean | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
  }["paused"]
  readonly eventTrigger?: {
    readonly name: string
    readonly prompt: string
    readonly location?: { readonly directory: string; readonly workspaceID?: string | null } | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly startsAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly paused?: boolean | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
  }["eventTrigger"]
}

export type LoopsCreateOutput = {
  readonly id: string
  readonly name: string
  readonly prompt: string
  readonly schedule:
    | { readonly type: "interval"; readonly seconds: number; readonly timezone: string }
    | { readonly type: "cron"; readonly seconds: number; readonly expression: string; readonly timezone: string }
  readonly status: "active" | "paused" | "expired"
  readonly location: { readonly directory: string; readonly workspaceID?: string | null }
  readonly agent?: string | null
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
  readonly skill?: string | null
  readonly workflow?: {
    readonly version: 1
    readonly steps: ReadonlyArray<
      | {
          readonly id: string
          readonly name: string
          readonly type: "agent"
          readonly prompt: string
          readonly agent?: string | null
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
          readonly when?: string | null
          readonly onFailure?: "stop" | "continue" | null
        }
      | {
          readonly id: string
          readonly name: string
          readonly type: "skill"
          readonly skill: string
          readonly instructions: string
          readonly agent?: string | null
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
          readonly when?: string | null
          readonly onFailure?: "stop" | "continue" | null
        }
    >
    readonly delivery: { readonly type: "turen" }
  } | null
  readonly eventTrigger?:
    | (
        | {
            readonly type: "file-change"
            readonly paths: ReadonlyArray<string>
            readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
          }
        | {
            readonly type: "session-end"
            readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
            readonly sessionID?: string | null
            readonly agent?: string | null
          }
      )
    | null
  readonly overlapPolicy: "skip"
  readonly startsAt: number | "Infinity" | "-Infinity" | "NaN"
  readonly expiresAt: number | "Infinity" | "-Infinity" | "NaN"
  readonly nextRunAt?: number | "Infinity" | "-Infinity" | "NaN" | null
  readonly time: {
    readonly created: number | "Infinity" | "-Infinity" | "NaN"
    readonly updated: number | "Infinity" | "-Infinity" | "NaN"
  }
}

export type LoopsListOutput = ReadonlyArray<{
  readonly id: string
  readonly name: string
  readonly prompt: string
  readonly schedule:
    | { readonly type: "interval"; readonly seconds: number; readonly timezone: string }
    | { readonly type: "cron"; readonly seconds: number; readonly expression: string; readonly timezone: string }
  readonly status: "active" | "paused" | "expired"
  readonly location: { readonly directory: string; readonly workspaceID?: string | null }
  readonly agent?: string | null
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
  readonly skill?: string | null
  readonly workflow?: {
    readonly version: 1
    readonly steps: ReadonlyArray<
      | {
          readonly id: string
          readonly name: string
          readonly type: "agent"
          readonly prompt: string
          readonly agent?: string | null
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
          readonly when?: string | null
          readonly onFailure?: "stop" | "continue" | null
        }
      | {
          readonly id: string
          readonly name: string
          readonly type: "skill"
          readonly skill: string
          readonly instructions: string
          readonly agent?: string | null
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
          readonly when?: string | null
          readonly onFailure?: "stop" | "continue" | null
        }
    >
    readonly delivery: { readonly type: "turen" }
  } | null
  readonly eventTrigger?:
    | (
        | {
            readonly type: "file-change"
            readonly paths: ReadonlyArray<string>
            readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
          }
        | {
            readonly type: "session-end"
            readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
            readonly sessionID?: string | null
            readonly agent?: string | null
          }
      )
    | null
  readonly overlapPolicy: "skip"
  readonly startsAt: number | "Infinity" | "-Infinity" | "NaN"
  readonly expiresAt: number | "Infinity" | "-Infinity" | "NaN"
  readonly nextRunAt?: number | "Infinity" | "-Infinity" | "NaN" | null
  readonly time: {
    readonly created: number | "Infinity" | "-Infinity" | "NaN"
    readonly updated: number | "Infinity" | "-Infinity" | "NaN"
  }
}>

export type LoopsGetInput = { readonly loopID: { readonly loopID: string }["loopID"] }

export type LoopsGetOutput = {
  readonly id: string
  readonly name: string
  readonly prompt: string
  readonly schedule:
    | { readonly type: "interval"; readonly seconds: number; readonly timezone: string }
    | { readonly type: "cron"; readonly seconds: number; readonly expression: string; readonly timezone: string }
  readonly status: "active" | "paused" | "expired"
  readonly location: { readonly directory: string; readonly workspaceID?: string | null }
  readonly agent?: string | null
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
  readonly skill?: string | null
  readonly workflow?: {
    readonly version: 1
    readonly steps: ReadonlyArray<
      | {
          readonly id: string
          readonly name: string
          readonly type: "agent"
          readonly prompt: string
          readonly agent?: string | null
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
          readonly when?: string | null
          readonly onFailure?: "stop" | "continue" | null
        }
      | {
          readonly id: string
          readonly name: string
          readonly type: "skill"
          readonly skill: string
          readonly instructions: string
          readonly agent?: string | null
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
          readonly when?: string | null
          readonly onFailure?: "stop" | "continue" | null
        }
    >
    readonly delivery: { readonly type: "turen" }
  } | null
  readonly eventTrigger?:
    | (
        | {
            readonly type: "file-change"
            readonly paths: ReadonlyArray<string>
            readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
          }
        | {
            readonly type: "session-end"
            readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
            readonly sessionID?: string | null
            readonly agent?: string | null
          }
      )
    | null
  readonly overlapPolicy: "skip"
  readonly startsAt: number | "Infinity" | "-Infinity" | "NaN"
  readonly expiresAt: number | "Infinity" | "-Infinity" | "NaN"
  readonly nextRunAt?: number | "Infinity" | "-Infinity" | "NaN" | null
  readonly time: {
    readonly created: number | "Infinity" | "-Infinity" | "NaN"
    readonly updated: number | "Infinity" | "-Infinity" | "NaN"
  }
}

export type LoopsEditInput = {
  readonly loopID: { readonly loopID: string }["loopID"]
  readonly name?: {
    readonly name?: string | null
    readonly prompt?: string | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
    readonly resetAgent?: boolean | null
    readonly resetModel?: boolean | null
    readonly resetSkill?: boolean | null
  }["name"]
  readonly prompt?: {
    readonly name?: string | null
    readonly prompt?: string | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
    readonly resetAgent?: boolean | null
    readonly resetModel?: boolean | null
    readonly resetSkill?: boolean | null
  }["prompt"]
  readonly intervalSeconds?: {
    readonly name?: string | null
    readonly prompt?: string | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
    readonly resetAgent?: boolean | null
    readonly resetModel?: boolean | null
    readonly resetSkill?: boolean | null
  }["intervalSeconds"]
  readonly cronExpression?: {
    readonly name?: string | null
    readonly prompt?: string | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
    readonly resetAgent?: boolean | null
    readonly resetModel?: boolean | null
    readonly resetSkill?: boolean | null
  }["cronExpression"]
  readonly timezone?: {
    readonly name?: string | null
    readonly prompt?: string | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
    readonly resetAgent?: boolean | null
    readonly resetModel?: boolean | null
    readonly resetSkill?: boolean | null
  }["timezone"]
  readonly expiresAt?: {
    readonly name?: string | null
    readonly prompt?: string | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
    readonly resetAgent?: boolean | null
    readonly resetModel?: boolean | null
    readonly resetSkill?: boolean | null
  }["expiresAt"]
  readonly agent?: {
    readonly name?: string | null
    readonly prompt?: string | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
    readonly resetAgent?: boolean | null
    readonly resetModel?: boolean | null
    readonly resetSkill?: boolean | null
  }["agent"]
  readonly model?: {
    readonly name?: string | null
    readonly prompt?: string | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
    readonly resetAgent?: boolean | null
    readonly resetModel?: boolean | null
    readonly resetSkill?: boolean | null
  }["model"]
  readonly skill?: {
    readonly name?: string | null
    readonly prompt?: string | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
    readonly resetAgent?: boolean | null
    readonly resetModel?: boolean | null
    readonly resetSkill?: boolean | null
  }["skill"]
  readonly workflow?: {
    readonly name?: string | null
    readonly prompt?: string | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
    readonly resetAgent?: boolean | null
    readonly resetModel?: boolean | null
    readonly resetSkill?: boolean | null
  }["workflow"]
  readonly eventTrigger?: {
    readonly name?: string | null
    readonly prompt?: string | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
    readonly resetAgent?: boolean | null
    readonly resetModel?: boolean | null
    readonly resetSkill?: boolean | null
  }["eventTrigger"]
  readonly resetAgent?: {
    readonly name?: string | null
    readonly prompt?: string | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
    readonly resetAgent?: boolean | null
    readonly resetModel?: boolean | null
    readonly resetSkill?: boolean | null
  }["resetAgent"]
  readonly resetModel?: {
    readonly name?: string | null
    readonly prompt?: string | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
    readonly resetAgent?: boolean | null
    readonly resetModel?: boolean | null
    readonly resetSkill?: boolean | null
  }["resetModel"]
  readonly resetSkill?: {
    readonly name?: string | null
    readonly prompt?: string | null
    readonly intervalSeconds?: number | null
    readonly cronExpression?: string | null
    readonly timezone?: string | null
    readonly expiresAt?: number | "Infinity" | "-Infinity" | "NaN" | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly skill?: string | null
    readonly workflow?: {
      readonly version: 1
      readonly steps: ReadonlyArray<
        | {
            readonly id: string
            readonly name: string
            readonly type: "agent"
            readonly prompt: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
        | {
            readonly id: string
            readonly name: string
            readonly type: "skill"
            readonly skill: string
            readonly instructions: string
            readonly agent?: string | null
            readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
            readonly when?: string | null
            readonly onFailure?: "stop" | "continue" | null
          }
      >
      readonly delivery: { readonly type: "turen" }
    } | null
    readonly eventTrigger?:
      | (
          | {
              readonly type: "file-change"
              readonly paths: ReadonlyArray<string>
              readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
            }
          | {
              readonly type: "session-end"
              readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
              readonly sessionID?: string | null
              readonly agent?: string | null
            }
        )
      | null
    readonly resetAgent?: boolean | null
    readonly resetModel?: boolean | null
    readonly resetSkill?: boolean | null
  }["resetSkill"]
}

export type LoopsEditOutput = {
  readonly id: string
  readonly name: string
  readonly prompt: string
  readonly schedule:
    | { readonly type: "interval"; readonly seconds: number; readonly timezone: string }
    | { readonly type: "cron"; readonly seconds: number; readonly expression: string; readonly timezone: string }
  readonly status: "active" | "paused" | "expired"
  readonly location: { readonly directory: string; readonly workspaceID?: string | null }
  readonly agent?: string | null
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
  readonly skill?: string | null
  readonly workflow?: {
    readonly version: 1
    readonly steps: ReadonlyArray<
      | {
          readonly id: string
          readonly name: string
          readonly type: "agent"
          readonly prompt: string
          readonly agent?: string | null
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
          readonly when?: string | null
          readonly onFailure?: "stop" | "continue" | null
        }
      | {
          readonly id: string
          readonly name: string
          readonly type: "skill"
          readonly skill: string
          readonly instructions: string
          readonly agent?: string | null
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
          readonly when?: string | null
          readonly onFailure?: "stop" | "continue" | null
        }
    >
    readonly delivery: { readonly type: "turen" }
  } | null
  readonly eventTrigger?:
    | (
        | {
            readonly type: "file-change"
            readonly paths: ReadonlyArray<string>
            readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
          }
        | {
            readonly type: "session-end"
            readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
            readonly sessionID?: string | null
            readonly agent?: string | null
          }
      )
    | null
  readonly overlapPolicy: "skip"
  readonly startsAt: number | "Infinity" | "-Infinity" | "NaN"
  readonly expiresAt: number | "Infinity" | "-Infinity" | "NaN"
  readonly nextRunAt?: number | "Infinity" | "-Infinity" | "NaN" | null
  readonly time: {
    readonly created: number | "Infinity" | "-Infinity" | "NaN"
    readonly updated: number | "Infinity" | "-Infinity" | "NaN"
  }
}

export type LoopsPauseInput = { readonly loopID: { readonly loopID: string }["loopID"] }

export type LoopsPauseOutput = {
  readonly id: string
  readonly name: string
  readonly prompt: string
  readonly schedule:
    | { readonly type: "interval"; readonly seconds: number; readonly timezone: string }
    | { readonly type: "cron"; readonly seconds: number; readonly expression: string; readonly timezone: string }
  readonly status: "active" | "paused" | "expired"
  readonly location: { readonly directory: string; readonly workspaceID?: string | null }
  readonly agent?: string | null
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
  readonly skill?: string | null
  readonly workflow?: {
    readonly version: 1
    readonly steps: ReadonlyArray<
      | {
          readonly id: string
          readonly name: string
          readonly type: "agent"
          readonly prompt: string
          readonly agent?: string | null
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
          readonly when?: string | null
          readonly onFailure?: "stop" | "continue" | null
        }
      | {
          readonly id: string
          readonly name: string
          readonly type: "skill"
          readonly skill: string
          readonly instructions: string
          readonly agent?: string | null
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
          readonly when?: string | null
          readonly onFailure?: "stop" | "continue" | null
        }
    >
    readonly delivery: { readonly type: "turen" }
  } | null
  readonly eventTrigger?:
    | (
        | {
            readonly type: "file-change"
            readonly paths: ReadonlyArray<string>
            readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
          }
        | {
            readonly type: "session-end"
            readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
            readonly sessionID?: string | null
            readonly agent?: string | null
          }
      )
    | null
  readonly overlapPolicy: "skip"
  readonly startsAt: number | "Infinity" | "-Infinity" | "NaN"
  readonly expiresAt: number | "Infinity" | "-Infinity" | "NaN"
  readonly nextRunAt?: number | "Infinity" | "-Infinity" | "NaN" | null
  readonly time: {
    readonly created: number | "Infinity" | "-Infinity" | "NaN"
    readonly updated: number | "Infinity" | "-Infinity" | "NaN"
  }
}

export type LoopsResumeInput = { readonly loopID: { readonly loopID: string }["loopID"] }

export type LoopsResumeOutput = {
  readonly id: string
  readonly name: string
  readonly prompt: string
  readonly schedule:
    | { readonly type: "interval"; readonly seconds: number; readonly timezone: string }
    | { readonly type: "cron"; readonly seconds: number; readonly expression: string; readonly timezone: string }
  readonly status: "active" | "paused" | "expired"
  readonly location: { readonly directory: string; readonly workspaceID?: string | null }
  readonly agent?: string | null
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
  readonly skill?: string | null
  readonly workflow?: {
    readonly version: 1
    readonly steps: ReadonlyArray<
      | {
          readonly id: string
          readonly name: string
          readonly type: "agent"
          readonly prompt: string
          readonly agent?: string | null
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
          readonly when?: string | null
          readonly onFailure?: "stop" | "continue" | null
        }
      | {
          readonly id: string
          readonly name: string
          readonly type: "skill"
          readonly skill: string
          readonly instructions: string
          readonly agent?: string | null
          readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
          readonly when?: string | null
          readonly onFailure?: "stop" | "continue" | null
        }
    >
    readonly delivery: { readonly type: "turen" }
  } | null
  readonly eventTrigger?:
    | (
        | {
            readonly type: "file-change"
            readonly paths: ReadonlyArray<string>
            readonly debounceMs?: number | "Infinity" | "-Infinity" | "NaN" | null
          }
        | {
            readonly type: "session-end"
            readonly outcomes?: ReadonlyArray<"success" | "failure"> | null
            readonly sessionID?: string | null
            readonly agent?: string | null
          }
      )
    | null
  readonly overlapPolicy: "skip"
  readonly startsAt: number | "Infinity" | "-Infinity" | "NaN"
  readonly expiresAt: number | "Infinity" | "-Infinity" | "NaN"
  readonly nextRunAt?: number | "Infinity" | "-Infinity" | "NaN" | null
  readonly time: {
    readonly created: number | "Infinity" | "-Infinity" | "NaN"
    readonly updated: number | "Infinity" | "-Infinity" | "NaN"
  }
}

export type LoopsDeleteInput = { readonly loopID: { readonly loopID: string }["loopID"] }

export type LoopsDeleteOutput = void

export type LoopsRunNowInput = { readonly loopID: { readonly loopID: string }["loopID"] }

export type LoopsRunNowOutput = {
  readonly id: string
  readonly loopID: string
  readonly scheduledAt: number
  readonly status: "claimed" | "running" | "succeeded" | "failed" | "cancelled" | "skipped" | "stale"
  readonly trigger: "scheduled" | "manual" | "file-change" | "session-end"
  readonly triggerPayload?: { readonly [x: string]: unknown } | undefined
  readonly currentStep: number
  readonly sessionID?: string | undefined
  readonly outputs: {
    readonly [x: string]: {
      readonly text: string
      readonly json?: unknown | undefined
      readonly artifacts: ReadonlyArray<
        | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string | undefined }
        | { readonly type: "output" | "changed"; readonly path: string }
      >
    }
  }
  readonly error?: string | undefined
  readonly time: {
    readonly created: number
    readonly updated: number
    readonly started?: number | undefined
    readonly completed?: number | undefined
  }
}

export type LoopsRunListInput = { readonly loopID: { readonly loopID: string }["loopID"] }

export type LoopsRunListOutput = ReadonlyArray<{
  readonly id: string
  readonly loopID: string
  readonly scheduledAt: number
  readonly status: "claimed" | "running" | "succeeded" | "failed" | "cancelled" | "skipped" | "stale"
  readonly trigger: "scheduled" | "manual" | "file-change" | "session-end"
  readonly triggerPayload?: { readonly [x: string]: unknown } | undefined
  readonly currentStep: number
  readonly sessionID?: string | undefined
  readonly outputs: {
    readonly [x: string]: {
      readonly text: string
      readonly json?: unknown | undefined
      readonly artifacts: ReadonlyArray<
        | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string | undefined }
        | { readonly type: "output" | "changed"; readonly path: string }
      >
    }
  }
  readonly error?: string | undefined
  readonly time: {
    readonly created: number
    readonly updated: number
    readonly started?: number | undefined
    readonly completed?: number | undefined
  }
}>

export type LoopsRunGetInput = {
  readonly loopID: { readonly loopID: string; readonly runID: string }["loopID"]
  readonly runID: { readonly loopID: string; readonly runID: string }["runID"]
}

export type LoopsRunGetOutput = {
  readonly id: string
  readonly loopID: string
  readonly scheduledAt: number
  readonly status: "claimed" | "running" | "succeeded" | "failed" | "cancelled" | "skipped" | "stale"
  readonly trigger: "scheduled" | "manual" | "file-change" | "session-end"
  readonly triggerPayload?: { readonly [x: string]: unknown } | undefined
  readonly currentStep: number
  readonly sessionID?: string | undefined
  readonly outputs: {
    readonly [x: string]: {
      readonly text: string
      readonly json?: unknown | undefined
      readonly artifacts: ReadonlyArray<
        | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string | undefined }
        | { readonly type: "output" | "changed"; readonly path: string }
      >
    }
  }
  readonly error?: string | undefined
  readonly time: {
    readonly created: number
    readonly updated: number
    readonly started?: number | undefined
    readonly completed?: number | undefined
  }
}

export type LoopsRunCancelInput = {
  readonly loopID: { readonly loopID: string; readonly runID: string }["loopID"]
  readonly runID: { readonly loopID: string; readonly runID: string }["runID"]
}

export type LoopsRunCancelOutput = {
  readonly id: string
  readonly loopID: string
  readonly scheduledAt: number
  readonly status: "claimed" | "running" | "succeeded" | "failed" | "cancelled" | "skipped" | "stale"
  readonly trigger: "scheduled" | "manual" | "file-change" | "session-end"
  readonly triggerPayload?: { readonly [x: string]: unknown } | undefined
  readonly currentStep: number
  readonly sessionID?: string | undefined
  readonly outputs: {
    readonly [x: string]: {
      readonly text: string
      readonly json?: unknown | undefined
      readonly artifacts: ReadonlyArray<
        | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string | undefined }
        | { readonly type: "output" | "changed"; readonly path: string }
      >
    }
  }
  readonly error?: string | undefined
  readonly time: {
    readonly created: number
    readonly updated: number
    readonly started?: number | undefined
    readonly completed?: number | undefined
  }
}

export type ServerIntelAdvisoriesInput = {
  readonly page?: {
    readonly page?: number | undefined
    readonly pageSize?: number | undefined
    readonly severity?: ("critical" | "high" | "medium" | "low" | "info") | undefined
    readonly search?: string | undefined
    readonly sort?: "publishedAt" | "severity" | "cvss" | "source" | "title" | undefined
    readonly order?: "asc" | "desc" | undefined
  }["page"]
  readonly pageSize?: {
    readonly page?: number | undefined
    readonly pageSize?: number | undefined
    readonly severity?: ("critical" | "high" | "medium" | "low" | "info") | undefined
    readonly search?: string | undefined
    readonly sort?: "publishedAt" | "severity" | "cvss" | "source" | "title" | undefined
    readonly order?: "asc" | "desc" | undefined
  }["pageSize"]
  readonly severity?: {
    readonly page?: number | undefined
    readonly pageSize?: number | undefined
    readonly severity?: ("critical" | "high" | "medium" | "low" | "info") | undefined
    readonly search?: string | undefined
    readonly sort?: "publishedAt" | "severity" | "cvss" | "source" | "title" | undefined
    readonly order?: "asc" | "desc" | undefined
  }["severity"]
  readonly search?: {
    readonly page?: number | undefined
    readonly pageSize?: number | undefined
    readonly severity?: ("critical" | "high" | "medium" | "low" | "info") | undefined
    readonly search?: string | undefined
    readonly sort?: "publishedAt" | "severity" | "cvss" | "source" | "title" | undefined
    readonly order?: "asc" | "desc" | undefined
  }["search"]
  readonly sort?: {
    readonly page?: number | undefined
    readonly pageSize?: number | undefined
    readonly severity?: ("critical" | "high" | "medium" | "low" | "info") | undefined
    readonly search?: string | undefined
    readonly sort?: "publishedAt" | "severity" | "cvss" | "source" | "title" | undefined
    readonly order?: "asc" | "desc" | undefined
  }["sort"]
  readonly order?: {
    readonly page?: number | undefined
    readonly pageSize?: number | undefined
    readonly severity?: ("critical" | "high" | "medium" | "low" | "info") | undefined
    readonly search?: string | undefined
    readonly sort?: "publishedAt" | "severity" | "cvss" | "source" | "title" | undefined
    readonly order?: "asc" | "desc" | undefined
  }["order"]
}

export type ServerIntelAdvisoriesOutput = {
  readonly items: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly severity: "critical" | "high" | "medium" | "low" | "info"
    readonly cvss?: number | undefined
    readonly publishedAt: number
    readonly updatedAt: number
    readonly source: string
    readonly url?: string | undefined
    readonly summary?: string | undefined
  }>
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

export type ServerIntelKevInput = {
  readonly page?: {
    readonly page?: number | undefined
    readonly pageSize?: number | undefined
    readonly sort?: "cveID" | "name" | "vendor" | "dateAdded" | "dueDate" | undefined
    readonly order?: "asc" | "desc" | undefined
  }["page"]
  readonly pageSize?: {
    readonly page?: number | undefined
    readonly pageSize?: number | undefined
    readonly sort?: "cveID" | "name" | "vendor" | "dateAdded" | "dueDate" | undefined
    readonly order?: "asc" | "desc" | undefined
  }["pageSize"]
  readonly sort?: {
    readonly page?: number | undefined
    readonly pageSize?: number | undefined
    readonly sort?: "cveID" | "name" | "vendor" | "dateAdded" | "dueDate" | undefined
    readonly order?: "asc" | "desc" | undefined
  }["sort"]
  readonly order?: {
    readonly page?: number | undefined
    readonly pageSize?: number | undefined
    readonly sort?: "cveID" | "name" | "vendor" | "dateAdded" | "dueDate" | undefined
    readonly order?: "asc" | "desc" | undefined
  }["order"]
}

export type ServerIntelKevOutput = {
  readonly items: ReadonlyArray<{
    readonly cveID: string
    readonly vendor: string
    readonly product: string
    readonly name: string
    readonly dateAdded: number
    readonly dueDate?: number | undefined
    readonly url?: string | undefined
  }>
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

export type ServerIntelNewsInput = {
  readonly page?: {
    readonly page?: number | undefined
    readonly pageSize?: number | undefined
    readonly sort?: "source" | "title" | "publishedAt" | undefined
    readonly order?: "asc" | "desc" | undefined
  }["page"]
  readonly pageSize?: {
    readonly page?: number | undefined
    readonly pageSize?: number | undefined
    readonly sort?: "source" | "title" | "publishedAt" | undefined
    readonly order?: "asc" | "desc" | undefined
  }["pageSize"]
  readonly sort?: {
    readonly page?: number | undefined
    readonly pageSize?: number | undefined
    readonly sort?: "source" | "title" | "publishedAt" | undefined
    readonly order?: "asc" | "desc" | undefined
  }["sort"]
  readonly order?: {
    readonly page?: number | undefined
    readonly pageSize?: number | undefined
    readonly sort?: "source" | "title" | "publishedAt" | undefined
    readonly order?: "asc" | "desc" | undefined
  }["order"]
}

export type ServerIntelNewsOutput = {
  readonly items: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly url: string
    readonly publishedAt: number
    readonly source: string
    readonly summary?: string | undefined
  }>
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

export type ServerIntelTrendsInput = { readonly days?: { readonly days?: number | undefined }["days"] }

export type ServerIntelTrendsOutput = {
  readonly points: ReadonlyArray<{ readonly date: string; readonly count: number }>
  readonly windowDays: number
}

export type ServerIntelFeedsOutput = ReadonlyArray<{
  readonly id: string
  readonly name: string
  readonly kind: "kev" | "nvd" | "epss" | "github" | "rss"
  readonly url: string
  readonly enabled: boolean
}>

export type ServerIntelFeedAddInput = {
  readonly id?: {
    readonly id?: string | undefined
    readonly name: string
    readonly kind: "kev" | "nvd" | "epss" | "github" | "rss"
    readonly url: string
    readonly enabled?: boolean | undefined
  }["id"]
  readonly name: {
    readonly id?: string | undefined
    readonly name: string
    readonly kind: "kev" | "nvd" | "epss" | "github" | "rss"
    readonly url: string
    readonly enabled?: boolean | undefined
  }["name"]
  readonly kind: {
    readonly id?: string | undefined
    readonly name: string
    readonly kind: "kev" | "nvd" | "epss" | "github" | "rss"
    readonly url: string
    readonly enabled?: boolean | undefined
  }["kind"]
  readonly url: {
    readonly id?: string | undefined
    readonly name: string
    readonly kind: "kev" | "nvd" | "epss" | "github" | "rss"
    readonly url: string
    readonly enabled?: boolean | undefined
  }["url"]
  readonly enabled?: {
    readonly id?: string | undefined
    readonly name: string
    readonly kind: "kev" | "nvd" | "epss" | "github" | "rss"
    readonly url: string
    readonly enabled?: boolean | undefined
  }["enabled"]
}

export type ServerIntelFeedAddOutput = {
  readonly id: string
  readonly name: string
  readonly kind: "kev" | "nvd" | "epss" | "github" | "rss"
  readonly url: string
  readonly enabled: boolean
}

export type ServerIntelFeedUpdateInput = {
  readonly feedID: { readonly feedID: string }["feedID"]
  readonly name?: {
    readonly name?: string | undefined
    readonly kind?: ("kev" | "nvd" | "epss" | "github" | "rss") | undefined
    readonly url?: string | undefined
    readonly enabled?: boolean | undefined
  }["name"]
  readonly kind?: {
    readonly name?: string | undefined
    readonly kind?: ("kev" | "nvd" | "epss" | "github" | "rss") | undefined
    readonly url?: string | undefined
    readonly enabled?: boolean | undefined
  }["kind"]
  readonly url?: {
    readonly name?: string | undefined
    readonly kind?: ("kev" | "nvd" | "epss" | "github" | "rss") | undefined
    readonly url?: string | undefined
    readonly enabled?: boolean | undefined
  }["url"]
  readonly enabled?: {
    readonly name?: string | undefined
    readonly kind?: ("kev" | "nvd" | "epss" | "github" | "rss") | undefined
    readonly url?: string | undefined
    readonly enabled?: boolean | undefined
  }["enabled"]
}

export type ServerIntelFeedUpdateOutput = {
  readonly id: string
  readonly name: string
  readonly kind: "kev" | "nvd" | "epss" | "github" | "rss"
  readonly url: string
  readonly enabled: boolean
}

export type ServerIntelFeedsResetOutput = ReadonlyArray<{
  readonly id: string
  readonly name: string
  readonly kind: "kev" | "nvd" | "epss" | "github" | "rss"
  readonly url: string
  readonly enabled: boolean
}>

export type ServerIntelStatusOutput = {
  readonly lastPollAt?: number | undefined
  readonly nextPollAt?: number | undefined
  readonly feeds: ReadonlyArray<{
    readonly feedID: string
    readonly lastPollAt?: number | undefined
    readonly lastOk?: boolean | undefined
    readonly lastError?: string | undefined
    readonly itemCount?: number | undefined
  }>
}

export type ServerIntelPollOutput = {
  readonly lastPollAt?: number | undefined
  readonly nextPollAt?: number | undefined
  readonly feeds: ReadonlyArray<{
    readonly feedID: string
    readonly lastPollAt?: number | undefined
    readonly lastOk?: boolean | undefined
    readonly lastError?: string | undefined
    readonly itemCount?: number | undefined
  }>
}

export type ServerWhiteboardGetInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type ServerWhiteboardGetOutput = {
  readonly sessionID: string
  readonly revision: number
  readonly elements: ReadonlyArray<{ readonly [x: string]: JsonValue }>
  readonly files: {
    readonly [x: string]: {
      readonly id: string
      readonly mimeType: string
      readonly dataURL: string
      readonly created: number | "Infinity" | "-Infinity" | "NaN"
      readonly lastRetrieved?: number | "Infinity" | "-Infinity" | "NaN"
    }
  }
  readonly updatedAt: number | "Infinity" | "-Infinity" | "NaN"
}

export type ServerWhiteboardUpdateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly patch: {
    readonly patch: {
      readonly elements: ReadonlyArray<{ readonly [x: string]: JsonValue }>
      readonly files?: {
        readonly [x: string]: {
          readonly id: string
          readonly mimeType: string
          readonly dataURL: string
          readonly created: number | "Infinity" | "-Infinity" | "NaN"
          readonly lastRetrieved?: number | "Infinity" | "-Infinity" | "NaN"
        }
      }
      readonly baseRevision?: number
    }
    readonly clientID: string
    readonly username: string
  }["patch"]
  readonly clientID: {
    readonly patch: {
      readonly elements: ReadonlyArray<{ readonly [x: string]: JsonValue }>
      readonly files?: {
        readonly [x: string]: {
          readonly id: string
          readonly mimeType: string
          readonly dataURL: string
          readonly created: number | "Infinity" | "-Infinity" | "NaN"
          readonly lastRetrieved?: number | "Infinity" | "-Infinity" | "NaN"
        }
      }
      readonly baseRevision?: number
    }
    readonly clientID: string
    readonly username: string
  }["clientID"]
  readonly username: {
    readonly patch: {
      readonly elements: ReadonlyArray<{ readonly [x: string]: JsonValue }>
      readonly files?: {
        readonly [x: string]: {
          readonly id: string
          readonly mimeType: string
          readonly dataURL: string
          readonly created: number | "Infinity" | "-Infinity" | "NaN"
          readonly lastRetrieved?: number | "Infinity" | "-Infinity" | "NaN"
        }
      }
      readonly baseRevision?: number
    }
    readonly clientID: string
    readonly username: string
  }["username"]
}

export type ServerWhiteboardUpdateOutput = {
  readonly sessionID: string
  readonly revision: number
  readonly elements: ReadonlyArray<{ readonly [x: string]: JsonValue }>
  readonly files: {
    readonly [x: string]: {
      readonly id: string
      readonly mimeType: string
      readonly dataURL: string
      readonly created: number | "Infinity" | "-Infinity" | "NaN"
      readonly lastRetrieved?: number | "Infinity" | "-Infinity" | "NaN"
    }
  }
  readonly updatedAt: number | "Infinity" | "-Infinity" | "NaN"
}

export type ServerWhiteboardPresenceInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly clientID: {
    readonly clientID: string
    readonly username: string
    readonly pointer?: {
      readonly x: number | "Infinity" | "-Infinity" | "NaN"
      readonly y: number | "Infinity" | "-Infinity" | "NaN"
    }
    readonly selectedElementIds?: ReadonlyArray<string>
  }["clientID"]
  readonly username: {
    readonly clientID: string
    readonly username: string
    readonly pointer?: {
      readonly x: number | "Infinity" | "-Infinity" | "NaN"
      readonly y: number | "Infinity" | "-Infinity" | "NaN"
    }
    readonly selectedElementIds?: ReadonlyArray<string>
  }["username"]
  readonly pointer?: {
    readonly clientID: string
    readonly username: string
    readonly pointer?: {
      readonly x: number | "Infinity" | "-Infinity" | "NaN"
      readonly y: number | "Infinity" | "-Infinity" | "NaN"
    }
    readonly selectedElementIds?: ReadonlyArray<string>
  }["pointer"]
  readonly selectedElementIds?: {
    readonly clientID: string
    readonly username: string
    readonly pointer?: {
      readonly x: number | "Infinity" | "-Infinity" | "NaN"
      readonly y: number | "Infinity" | "-Infinity" | "NaN"
    }
    readonly selectedElementIds?: ReadonlyArray<string>
  }["selectedElementIds"]
}

export type ServerWhiteboardPresenceOutput = {
  readonly participants: ReadonlyArray<{
    readonly clientID: string
    readonly username: string
    readonly pointer?: {
      readonly x: number | "Infinity" | "-Infinity" | "NaN"
      readonly y: number | "Infinity" | "-Infinity" | "NaN"
    }
    readonly selectedElementIds?: ReadonlyArray<string>
    readonly updatedAt: number | "Infinity" | "-Infinity" | "NaN"
  }>
}

export type ServerWhiteboardEventsInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type ServerWhiteboardEventsOutput =
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.whiteboard.updated"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly sessionID: string
        readonly revision: number
        readonly actor: { readonly id: string; readonly name: string; readonly kind: "human" | "agent" }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.whiteboard.presence"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: {
        readonly sessionID: string
        readonly participants: ReadonlyArray<{
          readonly clientID: string
          readonly username: string
          readonly pointer?: { readonly x: number; readonly y: number }
          readonly selectedElementIds?: ReadonlyArray<string>
          readonly updatedAt: number
        }>
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.whiteboard.connected"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
      readonly data: { readonly sessionID: string; readonly revision: number }
    }
