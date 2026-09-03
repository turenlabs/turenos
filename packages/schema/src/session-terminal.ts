export * as SessionTerminal from "./session-terminal"

import { Schema } from "effect"
import { Pty } from "./pty"
import { Workspace } from "./workspace"

export const State = Schema.Struct({
  ptyID: Pty.ID,
  shared: Schema.Boolean,
  info: Pty.Info,
  workspaceID: Workspace.ID.pipe(Schema.optional),
}).annotate({ identifier: "SessionTerminal.State" })
export type State = typeof State.Type
