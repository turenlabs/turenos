import { Layer } from "effect"
import { MessageHandler } from "./handlers/message"
import { SessionHandler } from "./handlers/session"
import { PermissionHandler } from "./handlers/permission"
import { FileSystemHandler } from "./handlers/fs"
import { CommandHandler } from "./handlers/command"
import { EventHandler } from "./handlers/event"
import { AgentHandler } from "./handlers/agent"
import { HealthHandler } from "./handlers/health"
import { PtyHandler } from "./handlers/pty"
import { QuestionHandler } from "./handlers/question"
import { LocationHandler } from "./handlers/location"
import { ProjectCopyHandler } from "./handlers/project-copy"
import { MemoryHandler } from "./handlers/memory"
import { LoopHandler } from "./handlers/loop"
import { IntelHandler } from "./handlers/intel"
import { WhiteboardHandler } from "./handlers/whiteboard"

export const handlers = Layer.mergeAll(
  HealthHandler,
  LocationHandler,
  AgentHandler,
  SessionHandler,
  MessageHandler,
  PermissionHandler,
  FileSystemHandler,
  CommandHandler,
  EventHandler,
  PtyHandler,
  QuestionHandler,
  ProjectCopyHandler,
  MemoryHandler,
  LoopHandler,
  IntelHandler,
  WhiteboardHandler,
)
