import { createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { PixelCritter } from "@turenlabs/ui/pixel-critter"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { getProjectAvatarVariant } from "@/context/layout"
import { enrichProject } from "@/context/project-enrich"
import { displayName, getProjectAvatarSource } from "@/pages/layout/helpers"
import { SettingsPageHeaderV2 } from "./page-header"
import "./zoo.css"

const HEART = [".X.X.", "XXXXX", "XXXXX", ".XXX.", "..X.."]
const SNACK = ["..sg.", ".aaa.", "aaaaa", "aaaaa", ".aaa."]

function PixelSprite(props: { rows: string[]; colors: Record<string, string>; class?: string; style?: string }) {
  const paths = createMemo(() =>
    Object.keys(props.colors).map((char) => ({
      fill: props.colors[char],
      d: props.rows
        .flatMap((row, y) => row.split("").flatMap((c, x) => (c === char ? [`M${x} ${y}h1v1h-1z`] : [])))
        .join(""),
    })),
  )
  return (
    <svg
      viewBox={`0 0 ${props.rows[0].length} ${props.rows.length}`}
      class={props.class}
      style={props.style}
      shape-rendering="crispEdges"
      aria-hidden="true"
    >
      <For each={paths()}>{(p) => <path d={p.d} fill={p.fill} />}</For>
    </svg>
  )
}

const HOP: Keyframe[] = [
  { transform: "translateY(0) scale(1, 1)" },
  { transform: "translateY(-32%) scale(1.06, 0.94)", offset: 0.35 },
  { transform: "translateY(0) scale(1.16, 0.8)", offset: 0.62 },
  { transform: "translateY(-7%) scale(0.95, 1.07)", offset: 0.82 },
  { transform: "translateY(0) scale(1, 1)" },
]
const NOM: Keyframe[] = [
  { transform: "scale(1, 1)" },
  { transform: "scale(1.18, 0.78)", offset: 0.3 },
  { transform: "scale(0.88, 1.14)", offset: 0.6 },
  { transform: "scale(1, 1)" },
]

export function SettingsZooV2() {
  const server = useServer()
  const serverSync = useServerSync()
  const critters = createMemo(() =>
    server.projects.list().map((open) => {
      const [childStore] = serverSync().child(open.worktree, { bootstrap: false })
      const metadata = childStore.project
        ? serverSync().data.project.find((x) => x.id === childStore.project)
        : serverSync().data.project.find((x) => x.worktree === open.worktree)
      const enriched = enrichProject({
        project: open,
        metadata,
        meta: childStore.projectMeta,
        icon: childStore.icon,
      })
      return {
        key: open.worktree,
        seed: enriched.id ?? open.worktree,
        name: displayName(enriched),
        variant: getProjectAvatarVariant(enriched.icon?.color),
        src: getProjectAvatarSource(enriched.id, enriched.icon),
      }
    }),
  )

  type Heart = { id: number; x: number; y: number; drift: number }
  type Snack = { id: number; x: number; y: number }
  const [state, setState] = createStore({
    pos: {} as Record<string, { x: number; y: number }>,
    hearts: [] as Heart[],
    snacks: [] as Snack[],
    pets: 0,
    fed: 0,
  })
  const sprites = new Map<string, HTMLElement>()
  const busy = new Set<string>()
  const claims = new Map<number, string>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let seq = 0

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t)
      fn()
    }, ms)
    timers.add(t)
  }

  const scatter = (i: number) => ({ x: 6 + ((i * 61) % 74), y: 8 + ((i * 37) % 58) })
  const pos = (key: string) => state.pos[key] ?? { x: 40, y: 30 }

  createEffect(() => {
    critters().forEach((c, i) => {
      if (!state.pos[c.key]) setState("pos", c.key, scatter(i))
    })
  })

  function hearts(x: number, y: number, count: number) {
    for (let i = 0; i < count; i++) {
      const id = ++seq
      const drift = (Math.random() - 0.5) * 26
      setState("hearts", (h) => [...h, { id, x, y, drift }])
      later(1100, () => setState("hearts", (h) => h.filter((v) => v.id !== id)))
    }
  }

  function pet(key: string) {
    sprites.get(key)?.animate(HOP, { duration: 550, easing: "ease-out" })
    const p = pos(key)
    hearts(p.x + 2, p.y, 2)
    setState("pets", (n) => n + 1)
  }

  function claimSnacks() {
    for (const snack of state.snacks) {
      if (claims.has(snack.id)) continue
      const free = critters().filter((c) => !busy.has(c.key))
      if (free.length === 0) return
      const nearest = free.reduce((a, b) => {
        const da = pos(a.key), db = pos(b.key)
        const distA = (da.x - snack.x) ** 2 + (da.y - snack.y) ** 2
        const distB = (db.x - snack.x) ** 2 + (db.y - snack.y) ** 2
        return distA <= distB ? a : b
      })
      busy.add(nearest.key)
      claims.set(snack.id, nearest.key)
      setState("pos", nearest.key, { x: snack.x - 2, y: snack.y - 4 })
      later(1000, () => {
        claims.delete(snack.id)
        busy.delete(nearest.key)
        setState("snacks", (s) => s.filter((v) => v.id !== snack.id))
        sprites.get(nearest.key)?.animate(NOM, { duration: 450, easing: "ease-in-out" })
        hearts(snack.x, snack.y, 1)
        setState("fed", (n) => n + 1)
        claimSnacks()
      })
    }
  }

  function feed() {
    const id = ++seq
    const x = 14 + Math.random() * 60
    const y = 24 + Math.random() * 52
    setState("snacks", (s) => [...s, { id, x, y }])
    claimSnacks()
  }

  onMount(() => {
    const wander = setInterval(() => {
      for (const c of critters()) {
        if (busy.has(c.key) || Math.random() > 0.3) continue
        setState("pos", c.key, { x: 6 + Math.random() * 76, y: 8 + Math.random() * 64 })
      }
    }, 3600)
    onCleanup(() => {
      clearInterval(wander)
      for (const t of timers) clearTimeout(t)
    })
  })

  return (
    <>
      <SettingsPageHeaderV2
        title="Zoo"
        description="Your project critters live here. Click one to pet it, or drop a snack and watch it waddle over."
        actions={
          <div class="zoo-toolbar">
            <Show when={state.pets + state.fed > 0}>
              <span class="zoo-stats">
                {state.pets} pets · {state.fed} snacks
              </span>
            </Show>
            <ButtonV2 variant="neutral" onClick={feed} disabled={critters().length === 0}>
              Drop a snack
            </ButtonV2>
          </div>
        }
      />
      <div class="settings-v2-tab-body zoo-body">
        <Show
          when={critters().length > 0}
          fallback={<div class="zoo-empty">Open a project and its critter will move in.</div>}
        >
          <div class="zoo-yard">
            <For each={critters()}>
              {(c, i) => (
                <button
                  type="button"
                  class="zoo-critter"
                  data-variant={c.variant}
                  style={{
                    left: `${pos(c.key).x}%`,
                    top: `${pos(c.key).y}%`,
                    "--zoo-bob-delay": `${-(i() * 0.7)}s`,
                  }}
                  onClick={() => pet(c.key)}
                  aria-label={`Pet ${c.name}`}
                >
                  <span class="zoo-critter-shadow" />
                  <span class="zoo-critter-bob" ref={(el) => sprites.set(c.key, el)}>
                    <Show
                      when={c.src}
                      keyed
                      fallback={
                        <span class="zoo-critter-sprite">
                          <PixelCritter seed={c.seed} shade="#000" />
                        </span>
                      }
                    >
                      {(src) => <img class="zoo-critter-img" src={src} alt="" />}
                    </Show>
                    <span class="zoo-critter-name">{c.name}</span>
                  </span>
                </button>
              )}
            </For>
            <For each={state.snacks}>
              {(snack) => (
                <PixelSprite
                  rows={SNACK}
                  colors={{ a: "#e5484d", s: "#8b5a2b", g: "#4caf50" }}
                  class="zoo-snack"
                  style={`left:${snack.x}%;top:${snack.y}%`}
                />
              )}
            </For>
            <For each={state.hearts}>
              {(heart) => (
                <span
                  class="zoo-heart"
                  style={{ left: `${heart.x}%`, top: `${heart.y}%`, "--drift": `${heart.drift}px` }}
                >
                  <PixelSprite rows={HEART} colors={{ X: "#ff6b9d" }} class="zoo-heart-sprite" />
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>
    </>
  )
}
