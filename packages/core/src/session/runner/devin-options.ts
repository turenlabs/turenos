export * as DevinOptions from "./devin-options"

import type { SessionConfigOption } from "@agentclientprotocol/sdk"

export const keys = ["mode", "thought_level", "speed"] as const
export type Selection = Readonly<Partial<Record<(typeof keys)[number], string>>>
type Option = Extract<SessionConfigOption, { type: "select" }>
export type Choice = { readonly id: string; readonly name: string }

const modeIDs = new Map([
  ["accept-edits", "code"],
  ["smart", "smart"],
  ["ask", "ask"],
  ["plan", "plan"],
])
const optionID = /^[a-zA-Z0-9][a-zA-Z0-9_.:+-]{0,159}$/

export function select(options: readonly SessionConfigOption[] | null | undefined, id: string) {
  return options?.find(
    (option): option is Option =>
      option.type === "select" && (option.id === id || (id !== "speed" && option.category === id)),
  )
}

export function choices(option: Option | undefined): Choice[] {
  const values = option?.options.flatMap((value) => ("options" in value ? value.options : [value])) ?? []
  return Array.from(
    new Map(
      values
        .slice(0, 512)
        .filter((value) => optionID.test(value.value) && value.name.trim().length > 0 && value.name.length <= 200)
        .map((value) => [value.value, { id: value.value, name: value.name.trim() }] as const),
    ).values(),
  )
}

export const allowedMode = (value: string) => modeIDs.has(value)

export function selection(body: Readonly<Record<string, unknown>>): Selection {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = body[key]
      return typeof value === "string" && optionID.test(value) ? [[key, value]] : []
    }),
  )
}

export type Options = {
  readonly modes: readonly Choice[]
  readonly thoughts: readonly Choice[]
  readonly speeds: readonly Choice[]
}

export const options = (config: readonly SessionConfigOption[] | null | undefined): Options => ({
  modes: choices(select(config, "mode")).filter((mode) => allowedMode(mode.id)),
  thoughts: choices(select(config, "thought_level")).slice(0, 8),
  speeds: choices(select(config, "speed")).slice(0, 4),
})

export function variants(options: Options) {
  return [undefined, ...options.modes].flatMap((mode) =>
    [undefined, ...options.thoughts].flatMap((thought) =>
      [undefined, ...options.speeds].flatMap((speed) => {
        const id = [mode ? modeIDs.get(mode.id) : undefined, thought?.id, speed?.id].filter(Boolean).join("-")
        return id && id !== "default"
          ? [
              {
                id,
                body: {
                  ...(mode && { mode: mode.id }),
                  ...(thought && { thought_level: thought.id }),
                  ...(speed && { speed: speed.id }),
                } satisfies Selection,
              },
            ]
          : []
      }),
    ),
  )
}
