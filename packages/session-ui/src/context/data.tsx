import type { Message, Session, Part, SnapshotFileDiff, SessionStatus } from "@turenlabs/sdk/v2"
import { createSimpleContext } from "@turenlabs/ui/context"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"
import type { BinarySnapshot } from "../components/binary-snapshot"

type Model = {
  id: string
  providerID: string
  name: string
  family?: string
  capabilities?: {
    reasoning: boolean
    input: {
      text: boolean
      audio: boolean
      image: boolean
      video: boolean
      pdf: boolean
    }
  }
  modalities?: {
    input: Array<string>
  }
  reasoning?: boolean
  limit: {
    context: number
  }
  release_date: string
  variants?: {
    [key: string]: {
      [key: string]: unknown
    }
  }
}

type Provider = {
  id: string
  name: string
  source?: "env" | "config" | "custom" | "api"
  auth?: "api" | "oauth" | "wellknown"
  env?: string[]
  key?: string
  options?: Record<string, unknown>
  models: {
    [key: string]: Model
  }
}

export type NormalizedProviderListResponse = {
  all: Map<string, Provider>
  default: {
    [key: string]: string
  }
  connected: Array<string>
}

type Data = {
  agent?: {
    name: string
    color?: string
  }[]
  provider?: NormalizedProviderListResponse
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: SnapshotFileDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  part_text_accum_delta?: {
    [partID: string]: string
  }
}

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
    onOpenBinaryInspector?: (snapshot: BinarySnapshot) => void
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
      openBinaryInspector: props.onOpenBinaryInspector,
    }
  },
})
