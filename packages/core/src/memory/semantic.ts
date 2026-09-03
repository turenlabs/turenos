export * as MemorySemantic from "./semantic"

import path from "node:path"
import { Context, Effect, Layer, Option } from "effect"
import { Potion, type PotionLoadOptions, type PotionRuntime } from "@turenlabs/plugin/potion"
import { Memory as MemorySchema } from "@turenlabs/schema/memory"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { Global } from "../global"
import { Memory } from "../memory"

const PAGE_SIZE = MemorySchema.MAX_SEARCH_LIMIT
const LEXICAL_LIMIT = MemorySchema.MAX_SEARCH_LIMIT
const SEMANTIC_WEIGHT = 0.65
const LEXICAL_WEIGHT = 1 - SEMANTIC_WEIGHT

export interface Interface {
  readonly prepare: () => Effect.Effect<void>
  readonly search: (input: Memory.SearchInput) => Effect.Effect<ReadonlyArray<Memory.Result>>
}

export class Service extends Context.Service<Service, Interface>()("@forge/MemorySemantic") {}

type IndexedDrawer = {
  readonly drawer: Memory.Drawer
  readonly vector: Float32Array
}

type PotionLoader = (options: PotionLoadOptions) => Promise<PotionRuntime>

const makeLayer = (load: PotionLoader) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const indexed = new Map<Memory.DrawerID, IndexedDrawer>()
      let potion: Promise<PotionRuntime> | undefined

      const loadRuntime = Effect.fn("MemorySemantic.loadRuntime")(function* () {
        const global = yield* Effect.serviceOption(Global.Service)
        const cacheDir = path.join(Option.getOrElse(global, Global.make).cache, "memory-embeddings")
        let pending: Promise<PotionRuntime> | undefined
        return yield* Effect.tryPromise({
          try: () => {
            pending = potion ?? (potion = load({ cacheDir }))
            return pending
          },
          catch: (error) => error,
        }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              // A temporary download or filesystem failure must not poison this
              // location until its services are rebuilt.
              if (pending !== undefined && potion === pending) potion = undefined
            }),
          ),
        )
      })

      const prepare = Effect.fn("MemorySemantic.prepare")(function* () {
        const config = yield* Effect.serviceOption(Config.Service)
        const semanticMemory = Option.isSome(config)
          ? Config.latest(yield* config.value.entries(), "semantic_memory")
          : undefined
        if (semanticMemory?.enabled !== true) return
        yield* loadRuntime().pipe(
          Effect.asVoid,
          Effect.catch(() => Effect.void),
        )
      })

      const search = Effect.fn("MemorySemantic.search")(function* (input: Memory.SearchInput) {
        const config = yield* Effect.serviceOption(Config.Service)
        const semanticMemory = Option.isSome(config)
          ? Config.latest(yield* config.value.entries(), "semantic_memory")
          : undefined
        const enabled = semanticMemory?.enabled === true
        if (!enabled || input.query.trim().length === 0) return yield* memory.search(input)

        const drawers = yield* listAll(memory, input)
        const lexical = yield* memory.search({ ...input, limit: LEXICAL_LIMIT })
        const result = yield* Effect.gen(function* () {
          const runtime = yield* loadRuntime()
          const ranked = yield* Effect.tryPromise({
            try: async () => {
              const current = new Map<Memory.DrawerID, Memory.Drawer>(
                drawers.map((drawer) => [drawer.id, drawer] as const),
              )
              for (const id of indexed.keys()) {
                if (!current.has(id)) indexed.delete(id)
              }

              const missing = drawers.filter((drawer) => {
                const existing = indexed.get(drawer.id)
                return existing === undefined || existing.drawer.timeUpdated !== drawer.timeUpdated
              })
              if (missing.length > 0) {
                const vectors = runtime.embed(missing.map(drawerText))
                for (const [index, drawer] of missing.entries()) {
                  indexed.set(drawer.id, { drawer, vector: vectors[index]! })
                }
              }

              const queryVector = runtime.embed([input.query.slice(0, MemorySchema.MAX_SEARCH_LENGTH)])[0]!
              const semanticScores = new Map<string, number>()
              for (const drawer of drawers) {
                const candidate = indexed.get(drawer.id)
                if (!candidate || !isValid(drawer, input)) continue
                semanticScores.set(drawer.id, dot(candidate.vector, queryVector))
              }

              const lexicalScores = new Map(lexical.map((item) => [item.drawer.id, item.score]))
              const semanticNormalized = normalize(semanticScores)
              const lexicalNormalized = normalize(lexicalScores)
              const limit = Math.max(
                1,
                Math.min(Math.floor(input.limit ?? MemorySchema.DEFAULT_SEARCH_LIMIT), LEXICAL_LIMIT),
              )
              return drawers
                .filter((drawer) => isValid(drawer, input))
                .map((drawer) => ({
                  drawer,
                  score:
                    SEMANTIC_WEIGHT * (semanticNormalized.get(drawer.id) ?? 0) +
                    LEXICAL_WEIGHT * (lexicalNormalized.get(drawer.id) ?? 0),
                }))
                .filter((item) => item.score > 0)
                .sort((a, b) => b.score - a.score || a.drawer.id.localeCompare(b.drawer.id))
                .slice(0, limit)
            },
            catch: (error) => error,
          })
          const validated = yield* Effect.forEach(ranked, (item) =>
            memory
              .read({ id: item.drawer.id, wings: input.wings })
              .pipe(
                Effect.map((drawer) =>
                  drawer && drawer.timeUpdated === item.drawer.timeUpdated && isValid(drawer, input)
                    ? { ...item, drawer }
                    : undefined,
                ),
              ),
          )
          return validated.flatMap((item) => (item === undefined ? [] : [item]))
        }).pipe(Effect.catch(() => memory.search(input)))
        return result
      })

      return Service.of({ prepare, search })
    }),
  )

export const layerWith = (load: PotionLoader) => makeLayer(load)

const layer = makeLayer(Potion.load)

export const node = makeLocationNode({
  name: "memory/semantic",
  layer,
  deps: [Memory.node],
})

function listAll(memory: Memory.Interface, input: Memory.SearchInput): Effect.Effect<Memory.Drawer[]> {
  return Effect.gen(function* () {
    const result: Memory.Drawer[] = []
    for (const wingID of input.wings) {
      let offset = 0
      while (true) {
        const page = yield* memory.list({
          wings: [wingID],
          rooms: input.rooms,
          limit: PAGE_SIZE,
          offset,
        })
        result.push(...page)
        if (page.length < PAGE_SIZE) break
        offset += PAGE_SIZE
      }
    }
    return result
  })
}

function drawerText(drawer: Memory.Drawer): string {
  return [drawer.title, drawer.body, drawer.anchor.path, drawer.anchor.symbol].filter(Boolean).join("\n")
}

function isValid(drawer: Memory.Drawer, input: Memory.SearchInput): boolean {
  if (input.rooms && input.rooms.length > 0 && !input.rooms.includes(drawer.roomID)) return false
  if (input.includeExpired) return true
  const asOf = input.asOf ?? Date.now()
  return drawer.timeValidFrom <= asOf && (drawer.timeValidUntil === undefined || drawer.timeValidUntil > asOf)
}

function normalize(scores: ReadonlyMap<string, number>): Map<string, number> {
  if (scores.size === 0) return new Map()
  let minimum = Infinity
  let maximum = -Infinity
  for (const score of scores.values()) {
    minimum = Math.min(minimum, score)
    maximum = Math.max(maximum, score)
  }
  if (maximum === minimum) return new Map([...scores.keys()].map((id) => [id, maximum === 0 ? 0 : 1]))
  return new Map([...scores.entries()].map(([id, score]) => [id, (score - minimum) / (maximum - minimum)]))
}

function dot(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length)
  let result = 0
  for (let index = 0; index < length; index += 1) result += a[index]! * b[index]!
  return result
}
