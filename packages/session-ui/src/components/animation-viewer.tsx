/// <reference path="./animation-virtual.d.ts" />
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { Animation } from "@turenlabs/schema/animation"
import runtime from "virtual:turen-animation-runtime"
import { animationSpec } from "./animation-data"
import { animationDocument } from "./animation-document"
import { animationMessage } from "./animation-protocol"
import { VisualizationLicenses } from "./visualization-licenses"
import "./animation-viewer.css"

export default function AnimationViewer(props: { metadata: unknown }) {
  const spec = createMemo(() => animationSpec(props.metadata))
  return (
    <Show when={spec()} keyed fallback={<p role="status">Animation data is unavailable or invalid.</p>}>
      {(value) => <AnimationScene spec={value} />}
    </Show>
  )
}

function AnimationScene(props: { spec: Animation.Spec }) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("")
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("")
  const html = animationDocument(props.spec, token, nonce, runtime)
  const [ready, setReady] = createSignal(false)
  const [paused, setPaused] = createSignal(true)
  const [time, setTime] = createSignal(0)
  const [duration, setDuration] = createSignal(
    Math.max(...props.spec.tracks.map((track) => (track.at ?? 0) + track.duration)),
  )
  const [speed, setSpeed] = createSignal(1)
  const [visible, setVisible] = createSignal(false)
  const [hidden, setHidden] = createSignal(document.hidden)
  const [reduced, setReduced] = createSignal(false)
  const [error, setError] = createSignal("")
  let iframe: HTMLIFrameElement | undefined
  let section: HTMLElement | undefined
  const canPlay = () => ready() && visible() && !hidden() && !document.hidden && !error()
  const send = (action: string, value?: number) => iframe?.contentWindow?.postMessage({ token, action, value }, "*")
  const pause = () => {
    send("pause")
    setPaused(true)
  }

  onMount(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(media.matches)
    const motion = () => {
      setReduced(media.matches)
      if (media.matches) pause()
    }
    const visibility = () => {
      setHidden(document.hidden)
      if (document.hidden) pause()
    }
    const receive = (event: MessageEvent) => {
      const message = animationMessage(event, iframe?.contentWindow ?? null, token)
      if (!message) return
      if (message.type === "error") {
        setError(message.message)
        pause()
        return
      }
      setReady(true)
      setTime(message.time)
      setDuration(message.duration)
      setPaused(message.paused)
      if (!message.paused && (!visible() || document.hidden)) pause()
    }
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting))
      if (!visible()) pause()
    })
    if (section) observer.observe(section)
    window.addEventListener("message", receive)
    document.addEventListener("visibilitychange", visibility)
    media.addEventListener("change", motion)
    onCleanup(() => {
      send("stop")
      observer.disconnect()
      window.removeEventListener("message", receive)
      document.removeEventListener("visibilitychange", visibility)
      media.removeEventListener("change", motion)
      iframe?.remove()
    })
  })

  return (
    <section ref={section} data-component="animation-viewer" aria-label={props.spec.title}>
      <header>
        <h3>{props.spec.title}</h3>
        <Show when={props.spec.description}>
          <p>{props.spec.description}</p>
        </Show>
      </header>
      <Show
        when={html}
        fallback={<p role="status">This HTML exceeds the rendering limits or cannot be displayed safely.</p>}
      >
        <iframe
          ref={iframe}
          title={props.spec.title}
          srcdoc={html}
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          onLoad={pause}
        />
        <div data-slot="animation-controls" role="group" aria-label="Animation playback">
          <button
            type="button"
            disabled={!canPlay()}
            onClick={() => {
              if (canPlay()) {
                send("play")
                setPaused(false)
              }
            }}
          >
            Play
          </button>
          <button type="button" disabled={!ready()} onClick={pause}>
            Pause
          </button>
          <button
            type="button"
            disabled={!ready()}
            onClick={() => {
              send("restart")
              setPaused(true)
              setTime(0)
            }}
          >
            Restart
          </button>
          <label>
            Position
            <input
              type="range"
              min="0"
              max={duration()}
              step="10"
              value={time()}
              disabled={!ready()}
              onInput={(event) => {
                const value = Number(event.currentTarget.value)
                send("seek", value)
                setTime(value)
                setPaused(true)
              }}
            />
          </label>
          <label>
            Speed
            <select
              value={speed()}
              disabled={!ready()}
              onChange={(event) => {
                const value = Number(event.currentTarget.value)
                send("speed", value)
                setSpeed(value)
              }}
            >
              <option value="0.25">0.25x</option>
              <option value="0.5">0.5x</option>
              <option value="1">1x</option>
              <option value="1.5">1.5x</option>
              <option value="2">2x</option>
            </select>
          </label>
        </div>
        <p role="status">
          {paused() ? "Paused" : "Playing"} / {(time() / 1000).toFixed(1)} / {(duration() / 1000).toFixed(1)} seconds
        </p>
        <Show when={reduced()}>
          <p>Reduced motion is enabled. Playback starts only when you select Play.</p>
        </Show>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
      </Show>
      <VisualizationLicenses />
    </section>
  )
}
