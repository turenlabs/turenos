import type { AgentV2Info, ExtensionItem, ForgeClient, LoopInfo, LoopRun } from "@turenlabs/sdk/v2/client"

export type { LoopInfo, LoopRun }
export type LoopLocation = LoopInfo["location"]
export type AutomationWorkflow = NonNullable<LoopInfo["workflow"]>

export type LoopModel = {
  id: string
  providerID: string
  name: string
  enabled: boolean
  variants: Array<{ id: string }>
}

type LoopSkill = {
  name: string
  description?: string
  location: string
  content: string
}

type Response<T> = Promise<{ data?: T | { data: T } }>

export type LoopApi = {
  list: () => Response<LoopInfo[]>
  create: (input: {
    name: string
    prompt: string
    location?: LoopLocation
    agent?: string
    model?: { id: string; providerID: string; variant?: string }
    skill?: string
    workflow?: AutomationWorkflow
    intervalSeconds: number
    timezone?: string
    startsAt?: number
    expiresAt?: number
    paused?: boolean
  }) => Response<LoopInfo>
  get: (input: { loopID: string }) => Response<LoopInfo>
  edit: (input: {
    loopID: string
    name?: string
    prompt?: string
    intervalSeconds?: number
    timezone?: string
    expiresAt?: number
    agent?: string | null
    model?: { id: string; providerID: string; variant?: string } | null
    skill?: string | null
    workflow?: AutomationWorkflow
  }) => Response<LoopInfo>
  pause: (input: { loopID: string }) => Response<LoopInfo>
  resume: (input: { loopID: string }) => Response<LoopInfo>
  delete: (input: { loopID: string }) => Response<unknown>
  runNow: (input: { loopID: string }) => Response<LoopRun>
  runList: (input: { loopID: string }) => Response<LoopRun[]>
  runGet: (input: { loopID: string; runID: string }) => Response<LoopRun>
  runCancel: (input: { loopID: string; runID: string }) => Response<LoopRun>
}

export async function loopCatalog(client: unknown, directory?: string, models: readonly LoopModel[] = []) {
  const v2 = (client as ForgeClient).v2
  const location = directory ? { directory } : undefined
  const [agents, extensions] = await Promise.all([
    v2.agent.list(location ? { location } : {}),
    (client as ForgeClient).extension.list(directory ? { directory } : {}),
  ])
  return {
    agents: responseData<AgentV2Info[]>(agents),
    models: [...models],
    skills: responseData<ExtensionItem[]>(extensions).flatMap((item) =>
      item.enabled
        ? item.manifest.contributions.flatMap((contribution) =>
            contribution.type === "skill"
              ? [
                  {
                    name: contribution.id,
                    description: contribution.description,
                    location: `/extension/${item.manifest.id}/${contribution.id}.md`,
                    content: contribution.source.type === "catalog" ? contribution.source.content : "",
                  } satisfies LoopSkill,
                ]
              : [],
          )
        : [],
    ),
  }
}

export function loopApi(client: unknown): LoopApi {
  const raw = (client as ForgeClient).v2.loop
  const run = raw.run
  return {
    list: () => raw.list(),
    create: (input) => raw.create({ loopCreateInput: input }),
    get: (input) => raw.get(input),
    edit: (input) => {
      const { loopID, agent, model, skill, ...rest } = input
      return raw.edit({
        loopID,
        loopEditInput: {
          ...rest,
          ...(agent === null ? { resetAgent: true } : agent === undefined ? {} : { agent }),
          ...(model === null ? { resetModel: true } : model === undefined ? {} : { model }),
          ...(skill === null ? { resetSkill: true } : skill === undefined ? {} : { skill }),
        },
      })
    },
    pause: (input) => raw.pause(input),
    resume: (input) => raw.resume(input),
    delete: (input) => raw.delete(input),
    runNow: (input) => raw.runNow(input),
    runList: (input) => run.list(input),
    runGet: (input) => run.get(input),
    runCancel: (input) => run.cancel(input),
  } satisfies LoopApi
}

export function responseData<T>(response: { data?: T | { data: T } }): T {
  const data = response.data
  if (data && typeof data === "object" && !Array.isArray(data) && "data" in data) return (data as { data: T }).data
  if (data === undefined) throw new Error("Loop API returned no data")
  return data
}
