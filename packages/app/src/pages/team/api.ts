import type { ForgeClient } from "@turenlabs/sdk/v2/client"
import type { Team } from "@turenlabs/schema/team"

export type TeamApi = {
  state: (input?: { roomID?: string; after?: number; before?: number; limit?: number }) => Promise<Team.State>
  roomCreate: (input: { name: string; topic?: string }) => Promise<Team.Room>
  roomEdit: (input: { roomID: string; edit: Team.EditRoom }) => Promise<Team.Room>
  roomArchive: (input: { roomID: string }) => Promise<Team.Room>
  roomRestore: (input: { roomID: string }) => Promise<Team.Room>
  roomDelete: (input: { roomID: string }) => Promise<void>
  teammateCreate: (input: Team.CreateTeammate) => Promise<Team.Teammate>
  teammateEdit: (input: { teammateID: string; edit: Team.EditTeammate }) => Promise<Team.Teammate>
  teammateStop: (input: { teammateID: string }) => Promise<unknown>
  messagePost: (input: Team.PostMessage) => Promise<Team.Posted>
  dutyAttach: (input: { teammateID: string; loopID: string }) => Promise<Team.Duty>
  taskCancel: (input: { taskID: string }) => Promise<Team.Task>
  factoryConfigure: (input: { roomID: string; config: Team.FactoryConfig }) => Promise<Team.Room>
  factoryRun: (input: { roomID: string; id: string; request?: string }) => Promise<Team.FactoryRun>
  factoryRunGet: (input: { runID: string }) => Promise<Team.FactoryRun>
  factoryRunCancel: (input: { runID: string }) => Promise<Team.FactoryRun>
}

export function teamApi(client: unknown): TeamApi {
  const raw = (client as ForgeClient).v2.team
  return {
    state: async (input) =>
      decode<Team.State>(
        raw.state({
          ...(input?.roomID ? { roomID: input.roomID } : {}),
          ...(input?.after === undefined ? {} : { after: String(input.after) }),
          ...(input?.before === undefined ? {} : { before: String(input.before) }),
          ...(input?.limit === undefined ? {} : { limit: String(input.limit) }),
        }),
      ),
    roomCreate: async (input) => decode<Team.Room>(raw.roomCreate(input)),
    roomEdit: async (input) => decode<Team.Room>(raw.roomEdit({ roomID: input.roomID, teamEditRoom: input.edit })),
    roomArchive: async (input) => decode<Team.Room>(raw.roomArchive(input)),
    roomRestore: async (input) => decode<Team.Room>(raw.roomRestore(input)),
    roomDelete: async (input) => {
      const result = await raw.roomDelete(input)
      checkError(result.error)
    },
    teammateCreate: async (input) =>
      decode<Team.Teammate>(
        raw.teammateCreate({
          teamCreateTeammate: {
            ...input,
            avatar: input.avatar
              ? ([...input.avatar] as [string, string, string, string, string, string, string, string])
              : undefined,
          },
        }),
      ),
    teammateEdit: async (input) =>
      decode<Team.Teammate>(
        raw.teammateEdit({
          teammateID: input.teammateID,
          teamEditTeammate: {
            ...input.edit,
            avatar: input.edit.avatar
              ? ([...input.edit.avatar] as [string, string, string, string, string, string, string, string])
              : undefined,
          },
        }),
      ),
    teammateStop: async (input) => decode<unknown>(raw.teammateStop(input)),
    messagePost: async (input) => decode<Team.Posted>(raw.messagePost({ teamPostMessage: input })),
    dutyAttach: async (input) => decode<Team.Duty>(raw.dutyAttach(input)),
    taskCancel: async (input) => decode<Team.Task>(raw.taskCancel(input)),
    factoryConfigure: async (input) =>
      decode<Team.Room>(
        raw.factoryConfigure({
          roomID: input.roomID,
          teamFactoryConfig: { ...input.config, teammateIDs: [...input.config.teammateIDs] },
        }),
      ),
    factoryRun: async (input) =>
      decode<Team.FactoryRun>(raw.factoryRun({ roomID: input.roomID, id: input.id, request: input.request })),
    factoryRunGet: async (input) => decode<Team.FactoryRun>(raw.factoryRunGet(input)),
    factoryRunCancel: async (input) => decode<Team.FactoryRun>(raw.factoryRunCancel(input)),
  } satisfies TeamApi
}

async function decode<T>(response: Promise<{ data?: unknown; error?: unknown }>): Promise<T> {
  const result = await response
  checkError(result.error)
  if (result.data === undefined) throw new Error("Team API returned no data")
  return result.data as T
}

function checkError(error: unknown) {
  if (error === undefined || error === null) return
  if (typeof error === "object" && "message" in error && typeof error.message === "string")
    throw new Error(error.message)
  throw new Error(typeof error === "string" ? error : "Team API request failed")
}
