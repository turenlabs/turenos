import type {
  HealthGetOutput,
  LocationGetInput,
  LocationGetOutput,
  AgentsListInput,
  AgentsListOutput,
  SessionsListInput,
  SessionsListOutput,
  SessionsCreateInput,
  SessionsCreateOutput,
  SessionsReplayInput,
  SessionsReplayOutput,
  SessionsActiveOutput,
  SessionsInterruptAllOutput,
  SessionsGetInput,
  SessionsGetOutput,
  SessionsGetTerminalInput,
  SessionsGetTerminalOutput,
  SessionsCreateTerminalInput,
  SessionsCreateTerminalOutput,
  SessionsShareTerminalInput,
  SessionsShareTerminalOutput,
  SessionsRemoveTerminalInput,
  SessionsRemoveTerminalOutput,
  SessionsStateInput,
  SessionsStateOutput,
  SessionsProposalInput,
  SessionsProposalOutput,
  SessionsProposalStatusInput,
  SessionsProposalStatusOutput,
  SessionsProposalApplyInput,
  SessionsProposalApplyOutput,
  SessionsProposalRejectInput,
  SessionsProposalRejectOutput,
  SessionsReloadInput,
  SessionsReloadOutput,
  SessionsRollbackInput,
  SessionsRollbackOutput,
  SessionsSwitchAgentInput,
  SessionsSwitchAgentOutput,
  SessionsSwitchModelInput,
  SessionsSwitchModelOutput,
  SessionsPromptInput,
  SessionsPromptOutput,
  SessionsShellInput,
  SessionsShellOutput,
  SessionsCommandInput,
  SessionsCommandOutput,
  SessionsResumeInput,
  SessionsResumeOutput,
  SessionsGoalGetInput,
  SessionsGoalGetOutput,
  SessionsGoalSetInput,
  SessionsGoalSetOutput,
  SessionsGoalEditInput,
  SessionsGoalEditOutput,
  SessionsGoalStatusInput,
  SessionsGoalStatusOutput,
  SessionsGoalClearInput,
  SessionsGoalClearOutput,
  SessionsTaskListInput,
  SessionsTaskListOutput,
  SessionsTaskGetInput,
  SessionsTaskGetOutput,
  SessionsTaskCancelInput,
  SessionsTaskCancelOutput,
  SessionsTeamBoardInput,
  SessionsTeamBoardOutput,
  SessionsCompactInput,
  SessionsCompactOutput,
  SessionsWaitInput,
  SessionsWaitOutput,
  SessionsStageInput,
  SessionsStageOutput,
  SessionsClearInput,
  SessionsClearOutput,
  SessionsCommitInput,
  SessionsCommitOutput,
  SessionsContextInput,
  SessionsContextOutput,
  SessionsPendingInputsInput,
  SessionsPendingInputsOutput,
  SessionsInputStatusInput,
  SessionsInputStatusOutput,
  SessionsOutboxInput,
  SessionsOutboxOutput,
  SessionsHistoryInput,
  SessionsHistoryOutput,
  SessionsReplayHistoryInput,
  SessionsReplayHistoryOutput,
  SessionsEventsInput,
  SessionsEventsOutput,
  SessionsInterruptInput,
  SessionsInterruptOutput,
  SessionsMessageInput,
  SessionsMessageOutput,
  MessagesListInput,
  MessagesListOutput,
  PermissionsListRequestsInput,
  PermissionsListRequestsOutput,
  PermissionsListSavedInput,
  PermissionsListSavedOutput,
  PermissionsRemoveSavedInput,
  PermissionsRemoveSavedOutput,
  PermissionsCreateInput,
  PermissionsCreateOutput,
  PermissionsListInput,
  PermissionsListOutput,
  PermissionsGetInput,
  PermissionsGetOutput,
  PermissionsReplyInput,
  PermissionsReplyOutput,
  FilesListInput,
  FilesListOutput,
  FilesFindInput,
  FilesFindOutput,
  CommandsListInput,
  CommandsListOutput,
  EventsSubscribeOutput,
  PtysListInput,
  PtysListOutput,
  PtysCreateInput,
  PtysCreateOutput,
  PtysGetInput,
  PtysGetOutput,
  PtysUpdateInput,
  PtysUpdateOutput,
  PtysRemoveInput,
  PtysRemoveOutput,
  QuestionsListRequestsInput,
  QuestionsListRequestsOutput,
  QuestionsListInput,
  QuestionsListOutput,
  QuestionsReplyInput,
  QuestionsReplyOutput,
  QuestionsRejectInput,
  QuestionsRejectOutput,
  ProjectCopiesCreateInput,
  ProjectCopiesCreateOutput,
  ProjectCopiesRemoveInput,
  ProjectCopiesRemoveOutput,
  ProjectCopiesRefreshInput,
  ProjectCopiesRefreshOutput,
  MemoriesWingsOutput,
  MemoriesWingInput,
  MemoriesWingOutput,
  MemoriesRoomsInput,
  MemoriesRoomsOutput,
  MemoriesRoomInput,
  MemoriesRoomOutput,
  MemoriesListInput,
  MemoriesListOutput,
  MemoriesCreateInput,
  MemoriesCreateOutput,
  MemoriesUpdateInput,
  MemoriesUpdateOutput,
  MemoriesRemoveInput,
  MemoriesRemoveOutput,
  LoopsCreateInput,
  LoopsCreateOutput,
  LoopsListOutput,
  LoopsGetInput,
  LoopsGetOutput,
  LoopsEditInput,
  LoopsEditOutput,
  LoopsPauseInput,
  LoopsPauseOutput,
  LoopsResumeInput,
  LoopsResumeOutput,
  LoopsDeleteInput,
  LoopsDeleteOutput,
  LoopsRunNowInput,
  LoopsRunNowOutput,
  LoopsRunListInput,
  LoopsRunListOutput,
  LoopsRunGetInput,
  LoopsRunGetOutput,
  LoopsRunCancelInput,
  LoopsRunCancelOutput,
  ServerIntelAdvisoriesInput,
  ServerIntelAdvisoriesOutput,
  ServerIntelKevInput,
  ServerIntelKevOutput,
  ServerIntelNewsInput,
  ServerIntelNewsOutput,
  ServerIntelTrendsInput,
  ServerIntelTrendsOutput,
  ServerIntelFeedsOutput,
  ServerIntelFeedAddInput,
  ServerIntelFeedAddOutput,
  ServerIntelFeedUpdateInput,
  ServerIntelFeedUpdateOutput,
  ServerIntelFeedsResetOutput,
  ServerIntelStatusOutput,
  ServerIntelPollOutput,
  ServerWhiteboardGetInput,
  ServerWhiteboardGetOutput,
  ServerWhiteboardUpdateInput,
  ServerWhiteboardUpdateOutput,
  ServerWhiteboardPresenceInput,
  ServerWhiteboardPresenceOutput,
  ServerWhiteboardEventsInput,
  ServerWhiteboardEventsOutput,
} from "./types"
import { ClientError } from "./client-error"

export interface ClientOptions {
  readonly baseUrl: string
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: HeadersInit
}

export interface RequestOptions {
  readonly signal?: AbortSignal
  readonly headers?: HeadersInit
}

interface RequestDescriptor {
  readonly method: string
  readonly path: string
  readonly query?: Record<string, unknown>
  readonly headers?: Record<string, unknown>
  readonly body?: unknown
  readonly successStatus: number
  readonly declaredStatuses: ReadonlyArray<number>
  readonly empty: boolean
}

export function make(options: ClientOptions) {
  const fetch = options.fetch ?? globalThis.fetch

  const prepare = (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    const url = new URL(descriptor.path, options.baseUrl)
    for (const [key, value] of Object.entries(descriptor.query ?? {})) appendQuery(url.searchParams, key, value)
    const headers = new Headers(options.headers)
    for (const [key, value] of Object.entries(descriptor.headers ?? {})) {
      if (value !== undefined && value !== null) headers.set(key, String(value))
    }
    for (const [key, value] of new Headers(requestOptions?.headers)) headers.set(key, value)
    if (descriptor.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
    return {
      url,
      init: {
        method: descriptor.method,
        signal: requestOptions?.signal,
        headers,
        body: descriptor.body === undefined ? undefined : JSON.stringify(descriptor.body),
      } satisfies RequestInit,
    }
  }

  const execute = async (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    try {
      const prepared = prepare(descriptor, requestOptions)
      return await fetch(prepared.url, prepared.init)
    } catch (cause) {
      throw new ClientError("Transport", { cause })
    }
  }

  const responseError = async (response: Response, descriptor: RequestDescriptor): Promise<never> => {
    if (descriptor.declaredStatuses.includes(response.status)) throw await json(response)
    try {
      await response.body?.cancel()
    } catch {}
    throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })
  }

  const request = async <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): Promise<A> => {
    const response = await execute(descriptor, requestOptions)
    if (response.status !== descriptor.successStatus) return responseError(response, descriptor)
    if (descriptor.empty) {
      try {
        await response.body?.cancel()
      } catch {}
      return undefined as A
    }
    return (await json(response)) as A
  }

  const sse = <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): AsyncIterable<A> => ({
    async *[Symbol.asyncIterator]() {
      const response = await execute(descriptor, requestOptions)
      if (response.status !== descriptor.successStatus) await responseError(response, descriptor)
      if (!isContentType(response, "text/event-stream")) {
        try {
          await response.body?.cancel()
        } catch {}
        throw new ClientError("UnsupportedContentType")
      }
      if (response.body === null) throw new ClientError("MalformedResponse")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        while (true) {
          let next
          try {
            next = await reader.read()
          } catch (cause) {
            throw new ClientError("Transport", { cause })
          }
          buffer += decoder.decode(next.value, { stream: !next.done })
          if (buffer.length > 1_048_576) throw new ClientError("MalformedResponse")
          const trailingCarriageReturn = !next.done && buffer.endsWith("\r")
          if (trailingCarriageReturn) buffer = buffer.slice(0, -1)
          buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
          if (trailingCarriageReturn) buffer += "\r"
          if (next.done && buffer !== "") buffer += "\n\n"
          let boundary = buffer.indexOf("\n\n")
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = block
              .split("\n")
              .flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trimStart()] : []))
              .join("\n")
            if (data !== "") {
              try {
                yield JSON.parse(data) as A
              } catch (cause) {
                throw new ClientError("MalformedResponse", { cause })
              }
            }
            boundary = buffer.indexOf("\n\n")
          }
          if (next.done) return
        }
      } finally {
        try {
          await reader.cancel()
        } catch {}
        reader.releaseLock()
      }
    },
  })

  return {
    health: {
      get: (requestOptions?: RequestOptions) =>
        request<HealthGetOutput>(
          { method: "GET", path: `/api/health`, successStatus: 200, declaredStatuses: [401, 400], empty: false },
          requestOptions,
        ),
    },
    location: {
      get: (input?: LocationGetInput, requestOptions?: RequestOptions) =>
        request<LocationGetOutput>(
          {
            method: "GET",
            path: `/api/location`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    agents: {
      list: (input?: AgentsListInput, requestOptions?: RequestOptions) =>
        request<AgentsListOutput>(
          {
            method: "GET",
            path: `/api/agent`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    sessions: {
      list: (input?: SessionsListInput, requestOptions?: RequestOptions) =>
        request<SessionsListOutput>(
          {
            method: "GET",
            path: `/api/session`,
            query: {
              workspace: input?.["workspace"],
              roots: input?.["roots"],
              archived: input?.["archived"],
              internal: input?.["internal"],
              inactive: input?.["inactive"],
              limit: input?.["limit"],
              order: input?.["order"],
              search: input?.["search"],
              directory: input?.["directory"],
              project: input?.["project"],
              subpath: input?.["subpath"],
              cursor: input?.["cursor"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      create: (input?: SessionsCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsCreateOutput }>(
          {
            method: "POST",
            path: `/api/session`,
            body: {
              id: input?.["id"],
              agent: input?.["agent"],
              model: input?.["model"],
              metadata: input?.["metadata"],
              location: input?.["location"],
            },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      replay: (input?: SessionsReplayInput, requestOptions?: RequestOptions) =>
        request<SessionsReplayOutput>(
          {
            method: "GET",
            path: `/api/session/replay`,
            query: { query: input?.["query"], limit: input?.["limit"], cursor: input?.["cursor"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      active: (requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsActiveOutput }>(
          {
            method: "GET",
            path: `/api/session/active`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      interruptAll: (requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsInterruptAllOutput }>(
          {
            method: "POST",
            path: `/api/session/interrupt-all`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: SessionsGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      getTerminal: (input: SessionsGetTerminalInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsGetTerminalOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/terminal`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      createTerminal: (input: SessionsCreateTerminalInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsCreateTerminalOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/terminal`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      shareTerminal: (input: SessionsShareTerminalInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsShareTerminalOutput }>(
          {
            method: "PUT",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/terminal/share`,
            body: { shared: input["shared"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      removeTerminal: (input: SessionsRemoveTerminalInput, requestOptions?: RequestOptions) =>
        request<SessionsRemoveTerminalOutput>(
          {
            method: "DELETE",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/terminal`,
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      state: (input: SessionsStateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsStateOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/harness`,
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      proposal: (input: SessionsProposalInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsProposalOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/harness/proposal`,
            body: {
              id: input["id"],
              baseVersion: input["baseVersion"],
              summary: input["summary"],
              changes: input["changes"],
              tools: input["tools"],
              guidance: input["guidance"],
            },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      proposalStatus: (input: SessionsProposalStatusInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsProposalStatusOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/harness/proposal/${encodeURIComponent(input.proposalID)}/status`,
            body: { status: input["status"], validation: input["validation"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      proposalApply: (input: SessionsProposalApplyInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsProposalApplyOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/harness/proposal/${encodeURIComponent(input.proposalID)}/apply`,
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      proposalReject: (input: SessionsProposalRejectInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsProposalRejectOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/harness/proposal/${encodeURIComponent(input.proposalID)}/reject`,
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      reload: (input: SessionsReloadInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsReloadOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/harness/reload`,
            body: { baseVersion: input["baseVersion"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      rollback: (input: SessionsRollbackInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsRollbackOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/harness/rollback`,
            body: { baseVersion: input["baseVersion"], version: input["version"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      switchAgent: (input: SessionsSwitchAgentInput, requestOptions?: RequestOptions) =>
        request<SessionsSwitchAgentOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/agent`,
            body: { agent: input["agent"] },
            successStatus: 204,
            declaredStatuses: [400, 404, 401],
            empty: true,
          },
          requestOptions,
        ),
      switchModel: (input: SessionsSwitchModelInput, requestOptions?: RequestOptions) =>
        request<SessionsSwitchModelOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/model`,
            body: { model: input["model"] },
            successStatus: 204,
            declaredStatuses: [400, 404, 401],
            empty: true,
          },
          requestOptions,
        ),
      prompt: (input: SessionsPromptInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsPromptOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/prompt`,
            body: {
              id: input["id"],
              prompt: input["prompt"],
              delivery: input["delivery"],
              agent: input["agent"],
              model: input["model"],
              resume: input["resume"],
            },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      shell: (input: SessionsShellInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsShellOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/shell`,
            body: { id: input["id"], command: input["command"], timeout: input["timeout"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      command: (input: SessionsCommandInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsCommandOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/command`,
            body: {
              id: input["id"],
              command: input["command"],
              arguments: input["arguments"],
              agent: input["agent"],
              model: input["model"],
              files: input["files"],
              resume: input["resume"],
            },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      resume: (input: SessionsResumeInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsResumeOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/resume`,
            successStatus: 200,
            declaredStatuses: [400, 503, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      goalGet: (input: SessionsGoalGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsGoalGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      goalSet: (input: SessionsGoalSetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsGoalSetOutput }>(
          {
            method: "PUT",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal`,
            body: {
              id: input["id"],
              messageID: input["messageID"],
              objective: input["objective"],
              agent: input["agent"],
              model: input["model"],
            },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      goalEdit: (input: SessionsGoalEditInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsGoalEditOutput }>(
          {
            method: "PATCH",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal`,
            body: {
              goalID: input["goalID"],
              expectedRevision: input["expectedRevision"],
              objective: input["objective"],
            },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      goalStatus: (input: SessionsGoalStatusInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsGoalStatusOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal/status`,
            body: { goalID: input["goalID"], expectedRevision: input["expectedRevision"], status: input["status"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      goalClear: (input: SessionsGoalClearInput, requestOptions?: RequestOptions) =>
        request<SessionsGoalClearOutput>(
          {
            method: "DELETE",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/goal`,
            body: { goalID: input["goalID"], expectedRevision: input["expectedRevision"] },
            successStatus: 204,
            declaredStatuses: [409, 400, 404, 401],
            empty: true,
          },
          requestOptions,
        ),
      taskList: (input: SessionsTaskListInput, requestOptions?: RequestOptions) =>
        request<SessionsTaskListOutput>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/task`,
            query: { limit: input["limit"], cursor: input["cursor"] },
            successStatus: 200,
            declaredStatuses: [400, 404, 401],
            empty: false,
          },
          requestOptions,
        ),
      taskGet: (input: SessionsTaskGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsTaskGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/task/${encodeURIComponent(input.taskID)}`,
            successStatus: 200,
            declaredStatuses: [400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      taskCancel: (input: SessionsTaskCancelInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsTaskCancelOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/task/${encodeURIComponent(input.taskID)}/cancel`,
            body: { expectedRevision: input["expectedRevision"] },
            successStatus: 200,
            declaredStatuses: [409, 400, 503, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      teamBoard: (input: SessionsTeamBoardInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsTeamBoardOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/team-board`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      compact: (input: SessionsCompactInput, requestOptions?: RequestOptions) =>
        request<SessionsCompactOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/compact`,
            successStatus: 204,
            declaredStatuses: [404, 503, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      wait: (input: SessionsWaitInput, requestOptions?: RequestOptions) =>
        request<SessionsWaitOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/wait`,
            successStatus: 204,
            declaredStatuses: [404, 503, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      stage: (input: SessionsStageInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsStageOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/stage`,
            body: { messageID: input["messageID"], files: input["files"] },
            successStatus: 200,
            declaredStatuses: [400, 404, 500, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      clear: (input: SessionsClearInput, requestOptions?: RequestOptions) =>
        request<SessionsClearOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/clear`,
            successStatus: 204,
            declaredStatuses: [400, 404, 500, 401],
            empty: true,
          },
          requestOptions,
        ),
      commit: (input: SessionsCommitInput, requestOptions?: RequestOptions) =>
        request<SessionsCommitOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/commit`,
            successStatus: 204,
            declaredStatuses: [409, 400, 404, 401],
            empty: true,
          },
          requestOptions,
        ),
      context: (input: SessionsContextInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsContextOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/context`,
            successStatus: 200,
            declaredStatuses: [400, 404, 500, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      pendingInputs: (input: SessionsPendingInputsInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsPendingInputsOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/input`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      inputStatus: (input: SessionsInputStatusInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsInputStatusOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/input/${encodeURIComponent(input.messageID)}`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      outbox: (input: SessionsOutboxInput, requestOptions?: RequestOptions) =>
        request<SessionsOutboxOutput>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/outbox`,
            query: { limit: input["limit"], cursor: input["cursor"], status: input["status"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ),
      history: (input: SessionsHistoryInput, requestOptions?: RequestOptions) =>
        request<SessionsHistoryOutput>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/history`,
            query: { limit: input["limit"], after: input["after"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ),
      replayHistory: (input: SessionsReplayHistoryInput, requestOptions?: RequestOptions) =>
        request<SessionsReplayHistoryOutput>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/replay`,
            query: {
              limit: input["limit"],
              cursor: input["cursor"],
              anchor: input["anchor"],
              direction: input["direction"],
            },
            successStatus: 200,
            declaredStatuses: [400, 404, 401],
            empty: false,
          },
          requestOptions,
        ),
      events: (input: SessionsEventsInput, requestOptions?: RequestOptions): AsyncIterable<SessionsEventsOutput> =>
        sse<SessionsEventsOutput>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/event`,
            query: { after: input["after"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ),
      interrupt: (input: SessionsInterruptInput, requestOptions?: RequestOptions) =>
        request<SessionsInterruptOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/interrupt`,
            successStatus: 204,
            declaredStatuses: [409, 400, 503, 404, 401],
            empty: true,
          },
          requestOptions,
        ),
      message: (input: SessionsMessageInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsMessageOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}`,
            successStatus: 200,
            declaredStatuses: [400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    messages: {
      list: (input: MessagesListInput, requestOptions?: RequestOptions) =>
        request<MessagesListOutput>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/message`,
            query: { limit: input["limit"], order: input["order"], cursor: input["cursor"] },
            successStatus: 200,
            declaredStatuses: [400, 404, 500, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    permissions: {
      listRequests: (input?: PermissionsListRequestsInput, requestOptions?: RequestOptions) =>
        request<PermissionsListRequestsOutput>(
          {
            method: "GET",
            path: `/api/permission/request`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      listSaved: (input?: PermissionsListSavedInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsListSavedOutput }>(
          {
            method: "GET",
            path: `/api/permission/saved`,
            query: { projectID: input?.["projectID"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      removeSaved: (input: PermissionsRemoveSavedInput, requestOptions?: RequestOptions) =>
        request<PermissionsRemoveSavedOutput>(
          {
            method: "DELETE",
            path: `/api/permission/saved/${encodeURIComponent(input.id)}`,
            successStatus: 204,
            declaredStatuses: [401, 400],
            empty: true,
          },
          requestOptions,
        ),
      create: (input: PermissionsCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsCreateOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission`,
            body: {
              id: input["id"],
              action: input["action"],
              resources: input["resources"],
              save: input["save"],
              metadata: input["metadata"],
              source: input["source"],
              agent: input["agent"],
            },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      list: (input: PermissionsListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: PermissionsGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(input.requestID)}`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      reply: (input: PermissionsReplyInput, requestOptions?: RequestOptions) =>
        request<PermissionsReplyOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(input.requestID)}/reply`,
            body: { reply: input["reply"], message: input["message"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
    },
    files: {
      list: (input?: FilesListInput, requestOptions?: RequestOptions) =>
        request<FilesListOutput>(
          {
            method: "GET",
            path: `/api/fs/list`,
            query: { location: input?.["location"], path: input?.["path"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      find: (input: FilesFindInput, requestOptions?: RequestOptions) =>
        request<FilesFindOutput>(
          {
            method: "GET",
            path: `/api/fs/find`,
            query: { location: input["location"], query: input["query"], type: input["type"], limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    commands: {
      list: (input?: CommandsListInput, requestOptions?: RequestOptions) =>
        request<CommandsListOutput>(
          {
            method: "GET",
            path: `/api/command`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    events: {
      subscribe: (requestOptions?: RequestOptions): AsyncIterable<EventsSubscribeOutput> =>
        sse<EventsSubscribeOutput>(
          { method: "GET", path: `/api/event`, successStatus: 200, declaredStatuses: [401, 400], empty: false },
          requestOptions,
        ),
    },
    ptys: {
      list: (input?: PtysListInput, requestOptions?: RequestOptions) =>
        request<PtysListOutput>(
          {
            method: "GET",
            path: `/api/pty`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      create: (input?: PtysCreateInput, requestOptions?: RequestOptions) =>
        request<PtysCreateOutput>(
          {
            method: "POST",
            path: `/api/pty`,
            query: { location: input?.["location"] },
            body: {
              command: input?.["command"],
              args: input?.["args"],
              cwd: input?.["cwd"],
              title: input?.["title"],
              env: input?.["env"],
            },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: PtysGetInput, requestOptions?: RequestOptions) =>
        request<PtysGetOutput>(
          {
            method: "GET",
            path: `/api/pty/${encodeURIComponent(input.ptyID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      update: (input: PtysUpdateInput, requestOptions?: RequestOptions) =>
        request<PtysUpdateOutput>(
          {
            method: "PUT",
            path: `/api/pty/${encodeURIComponent(input.ptyID)}`,
            query: { location: input["location"] },
            body: { title: input["title"], size: input["size"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: PtysRemoveInput, requestOptions?: RequestOptions) =>
        request<PtysRemoveOutput>(
          {
            method: "DELETE",
            path: `/api/pty/${encodeURIComponent(input.ptyID)}`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [404, 401, 400],
            empty: true,
          },
          requestOptions,
        ),
    },
    questions: {
      listRequests: (input?: QuestionsListRequestsInput, requestOptions?: RequestOptions) =>
        request<QuestionsListRequestsOutput>(
          {
            method: "GET",
            path: `/api/question/request`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      list: (input: QuestionsListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: QuestionsListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/question`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      reply: (input: QuestionsReplyInput, requestOptions?: RequestOptions) =>
        request<QuestionsReplyOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/question/${encodeURIComponent(input.requestID)}/reply`,
            body: { answers: input["answers"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      reject: (input: QuestionsRejectInput, requestOptions?: RequestOptions) =>
        request<QuestionsRejectOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/question/${encodeURIComponent(input.requestID)}/reject`,
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
    },
    projectCopies: {
      create: (input: ProjectCopiesCreateInput, requestOptions?: RequestOptions) =>
        request<ProjectCopiesCreateOutput>(
          {
            method: "POST",
            path: `/experimental/project/${encodeURIComponent(input.projectID)}/copy`,
            query: { location: input["location"] },
            body: { strategy: input["strategy"], directory: input["directory"], name: input["name"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: ProjectCopiesRemoveInput, requestOptions?: RequestOptions) =>
        request<ProjectCopiesRemoveOutput>(
          {
            method: "DELETE",
            path: `/experimental/project/${encodeURIComponent(input.projectID)}/copy`,
            query: { location: input["location"] },
            body: { directory: input["directory"], force: input["force"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
            empty: true,
          },
          requestOptions,
        ),
      refresh: (input: ProjectCopiesRefreshInput, requestOptions?: RequestOptions) =>
        request<ProjectCopiesRefreshOutput>(
          {
            method: "POST",
            path: `/experimental/project/${encodeURIComponent(input.projectID)}/copy/refresh`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
            empty: true,
          },
          requestOptions,
        ),
    },
    memories: {
      wings: (requestOptions?: RequestOptions) =>
        request<MemoriesWingsOutput>(
          { method: "GET", path: `/api/memory/wing`, successStatus: 200, declaredStatuses: [401, 400], empty: false },
          requestOptions,
        ),
      wing: (input: MemoriesWingInput, requestOptions?: RequestOptions) =>
        request<MemoriesWingOutput>(
          {
            method: "POST",
            path: `/api/memory/wing`,
            body: { kind: input["kind"], key: input["key"], name: input["name"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      rooms: (input: MemoriesRoomsInput, requestOptions?: RequestOptions) =>
        request<MemoriesRoomsOutput>(
          {
            method: "GET",
            path: `/api/memory/room`,
            query: { wingID: input["wingID"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      room: (input: MemoriesRoomInput, requestOptions?: RequestOptions) =>
        request<MemoriesRoomOutput>(
          {
            method: "POST",
            path: `/api/memory/room`,
            body: { wingID: input["wingID"], slug: input["slug"], name: input["name"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      list: (input: MemoriesListInput, requestOptions?: RequestOptions) =>
        request<MemoriesListOutput>(
          {
            method: "GET",
            path: `/api/memory`,
            query: { wingID: input["wingID"], roomID: input["roomID"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      create: (input: MemoriesCreateInput, requestOptions?: RequestOptions) =>
        request<MemoriesCreateOutput>(
          {
            method: "POST",
            path: `/api/memory`,
            body: {
              wingID: input["wingID"],
              roomID: input["roomID"],
              kind: input["kind"],
              title: input["title"],
              body: input["body"],
              anchor: input["anchor"],
              validFrom: input["validFrom"],
              supersedes: input["supersedes"],
            },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      update: (input: MemoriesUpdateInput, requestOptions?: RequestOptions) =>
        request<MemoriesUpdateOutput>(
          {
            method: "PATCH",
            path: `/api/memory/${encodeURIComponent(input.drawerID)}`,
            body: {
              expectedTimeUpdated: input["expectedTimeUpdated"],
              wingID: input["wingID"],
              roomID: input["roomID"],
              kind: input["kind"],
              title: input["title"],
              body: input["body"],
              anchor: input["anchor"],
            },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: MemoriesRemoveInput, requestOptions?: RequestOptions) =>
        request<MemoriesRemoveOutput>(
          {
            method: "DELETE",
            path: `/api/memory/${encodeURIComponent(input.drawerID)}`,
            query: { wingID: input["wingID"] },
            successStatus: 204,
            declaredStatuses: [404, 401, 400],
            empty: true,
          },
          requestOptions,
        ),
    },
    loops: {
      create: (input: LoopsCreateInput, requestOptions?: RequestOptions) =>
        request<LoopsCreateOutput>(
          {
            method: "POST",
            path: `/api/loop`,
            body: {
              name: input["name"],
              prompt: input["prompt"],
              location: input["location"],
              agent: input["agent"],
              model: input["model"],
              skill: input["skill"],
              workflow: input["workflow"],
              intervalSeconds: input["intervalSeconds"],
              cronExpression: input["cronExpression"],
              timezone: input["timezone"],
              startsAt: input["startsAt"],
              expiresAt: input["expiresAt"],
              paused: input["paused"],
              eventTrigger: input["eventTrigger"],
            },
            successStatus: 200,
            declaredStatuses: [400, 409, 404, 401],
            empty: false,
          },
          requestOptions,
        ),
      list: (requestOptions?: RequestOptions) =>
        request<LoopsListOutput>(
          { method: "GET", path: `/api/loop`, successStatus: 200, declaredStatuses: [401, 400], empty: false },
          requestOptions,
        ),
      get: (input: LoopsGetInput, requestOptions?: RequestOptions) =>
        request<LoopsGetOutput>(
          {
            method: "GET",
            path: `/api/loop/${encodeURIComponent(input.loopID)}`,
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      edit: (input: LoopsEditInput, requestOptions?: RequestOptions) =>
        request<LoopsEditOutput>(
          {
            method: "PATCH",
            path: `/api/loop/${encodeURIComponent(input.loopID)}`,
            body: {
              name: input["name"],
              prompt: input["prompt"],
              intervalSeconds: input["intervalSeconds"],
              cronExpression: input["cronExpression"],
              timezone: input["timezone"],
              expiresAt: input["expiresAt"],
              agent: input["agent"],
              model: input["model"],
              skill: input["skill"],
              workflow: input["workflow"],
              eventTrigger: input["eventTrigger"],
              resetAgent: input["resetAgent"],
              resetModel: input["resetModel"],
              resetSkill: input["resetSkill"],
            },
            successStatus: 200,
            declaredStatuses: [400, 409, 404, 401],
            empty: false,
          },
          requestOptions,
        ),
      pause: (input: LoopsPauseInput, requestOptions?: RequestOptions) =>
        request<LoopsPauseOutput>(
          {
            method: "POST",
            path: `/api/loop/${encodeURIComponent(input.loopID)}/pause`,
            successStatus: 200,
            declaredStatuses: [400, 409, 404, 401],
            empty: false,
          },
          requestOptions,
        ),
      resume: (input: LoopsResumeInput, requestOptions?: RequestOptions) =>
        request<LoopsResumeOutput>(
          {
            method: "POST",
            path: `/api/loop/${encodeURIComponent(input.loopID)}/resume`,
            successStatus: 200,
            declaredStatuses: [400, 409, 404, 401],
            empty: false,
          },
          requestOptions,
        ),
      delete: (input: LoopsDeleteInput, requestOptions?: RequestOptions) =>
        request<LoopsDeleteOutput>(
          {
            method: "DELETE",
            path: `/api/loop/${encodeURIComponent(input.loopID)}`,
            successStatus: 204,
            declaredStatuses: [400, 409, 404, 401],
            empty: true,
          },
          requestOptions,
        ),
      runNow: (input: LoopsRunNowInput, requestOptions?: RequestOptions) =>
        request<LoopsRunNowOutput>(
          {
            method: "POST",
            path: `/api/loop/${encodeURIComponent(input.loopID)}/run`,
            successStatus: 200,
            declaredStatuses: [400, 409, 404, 401],
            empty: false,
          },
          requestOptions,
        ),
      runList: (input: LoopsRunListInput, requestOptions?: RequestOptions) =>
        request<LoopsRunListOutput>(
          {
            method: "GET",
            path: `/api/loop/${encodeURIComponent(input.loopID)}/run`,
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      runGet: (input: LoopsRunGetInput, requestOptions?: RequestOptions) =>
        request<LoopsRunGetOutput>(
          {
            method: "GET",
            path: `/api/loop/${encodeURIComponent(input.loopID)}/run/${encodeURIComponent(input.runID)}`,
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      runCancel: (input: LoopsRunCancelInput, requestOptions?: RequestOptions) =>
        request<LoopsRunCancelOutput>(
          {
            method: "POST",
            path: `/api/loop/${encodeURIComponent(input.loopID)}/run/${encodeURIComponent(input.runID)}/cancel`,
            successStatus: 200,
            declaredStatuses: [409, 404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    "server.intel": {
      advisories: (input?: ServerIntelAdvisoriesInput, requestOptions?: RequestOptions) =>
        request<ServerIntelAdvisoriesOutput>(
          {
            method: "GET",
            path: `/api/intel/advisories`,
            query: {
              page: input?.["page"],
              pageSize: input?.["pageSize"],
              severity: input?.["severity"],
              search: input?.["search"],
            },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      kev: (input?: ServerIntelKevInput, requestOptions?: RequestOptions) =>
        request<ServerIntelKevOutput>(
          {
            method: "GET",
            path: `/api/intel/kev`,
            query: { page: input?.["page"], pageSize: input?.["pageSize"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      news: (input?: ServerIntelNewsInput, requestOptions?: RequestOptions) =>
        request<ServerIntelNewsOutput>(
          {
            method: "GET",
            path: `/api/intel/news`,
            query: { page: input?.["page"], pageSize: input?.["pageSize"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      trends: (input?: ServerIntelTrendsInput, requestOptions?: RequestOptions) =>
        request<ServerIntelTrendsOutput>(
          {
            method: "GET",
            path: `/api/intel/trends`,
            query: { days: input?.["days"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      feeds: (requestOptions?: RequestOptions) =>
        request<ServerIntelFeedsOutput>(
          { method: "GET", path: `/api/intel/feeds`, successStatus: 200, declaredStatuses: [401, 400], empty: false },
          requestOptions,
        ),
      feedAdd: (input: ServerIntelFeedAddInput, requestOptions?: RequestOptions) =>
        request<ServerIntelFeedAddOutput>(
          {
            method: "POST",
            path: `/api/intel/feeds`,
            body: {
              id: input["id"],
              name: input["name"],
              kind: input["kind"],
              url: input["url"],
              enabled: input["enabled"],
            },
            successStatus: 200,
            declaredStatuses: [400, 409, 401],
            empty: false,
          },
          requestOptions,
        ),
      feedUpdate: (input: ServerIntelFeedUpdateInput, requestOptions?: RequestOptions) =>
        request<ServerIntelFeedUpdateOutput>(
          {
            method: "PATCH",
            path: `/api/intel/feeds/${encodeURIComponent(input.feedID)}`,
            body: { name: input["name"], kind: input["kind"], url: input["url"], enabled: input["enabled"] },
            successStatus: 200,
            declaredStatuses: [400, 404, 401],
            empty: false,
          },
          requestOptions,
        ),
      feedsReset: (requestOptions?: RequestOptions) =>
        request<ServerIntelFeedsResetOutput>(
          {
            method: "POST",
            path: `/api/intel/feeds/reset`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      status: (requestOptions?: RequestOptions) =>
        request<ServerIntelStatusOutput>(
          { method: "GET", path: `/api/intel/status`, successStatus: 200, declaredStatuses: [401, 400], empty: false },
          requestOptions,
        ),
      poll: (requestOptions?: RequestOptions) =>
        request<ServerIntelPollOutput>(
          { method: "POST", path: `/api/intel/poll`, successStatus: 200, declaredStatuses: [401, 400], empty: false },
          requestOptions,
        ),
    },
    "server.whiteboard": {
      get: (input: ServerWhiteboardGetInput, requestOptions?: RequestOptions) =>
        request<ServerWhiteboardGetOutput>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/whiteboard`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ),
      update: (input: ServerWhiteboardUpdateInput, requestOptions?: RequestOptions) =>
        request<ServerWhiteboardUpdateOutput>(
          {
            method: "PATCH",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/whiteboard`,
            body: { patch: input["patch"], clientID: input["clientID"], username: input["username"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 409, 401],
            empty: false,
          },
          requestOptions,
        ),
      presence: (input: ServerWhiteboardPresenceInput, requestOptions?: RequestOptions) =>
        request<ServerWhiteboardPresenceOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/whiteboard/presence`,
            body: {
              clientID: input["clientID"],
              username: input["username"],
              pointer: input["pointer"],
              selectedElementIds: input["selectedElementIds"],
            },
            successStatus: 200,
            declaredStatuses: [404, 400, 409, 401],
            empty: false,
          },
          requestOptions,
        ),
      events: (
        input: ServerWhiteboardEventsInput,
        requestOptions?: RequestOptions,
      ): AsyncIterable<ServerWhiteboardEventsOutput> =>
        sse<ServerWhiteboardEventsOutput>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/whiteboard/events`,
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
  }
}

function appendQuery(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(params, key, item)
    return
  }
  if (typeof value === "object") {
    for (const [child, item] of Object.entries(value)) appendQuery(params, `${key}[${child}]`, item)
    return
  }
  params.append(key, String(value))
}

async function json(response: Response): Promise<unknown> {
  if (!isContentType(response, "application/json") && !response.headers.get("content-type")?.includes("+json")) {
    try {
      await response.body?.cancel()
    } catch {}
    throw new ClientError("UnsupportedContentType")
  }
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    throw new ClientError("Transport", { cause })
  }
  if (text === "") throw new ClientError("MalformedResponse")
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new ClientError("MalformedResponse", { cause })
  }
}

function isContentType(response: Response, expected: string) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected
}
