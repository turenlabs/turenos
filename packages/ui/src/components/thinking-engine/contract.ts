// State labels follow thinking-orbs at commit eda2d708b99ab871993bbea5a5f08d23a14da436.
// Copyright (c) 2026 Jakub Antalik. MIT licensed; see THIRD_PARTY_LICENSE.txt.

import type { ComponentProps } from "solid-js"
import type { ThinkingSize, ThinkingState } from "./presets"

export const THINKING_LABELS: Record<ThinkingState, string> = {
  working: "Working…",
  searching: "Searching…",
  solving: "Solving…",
  listening: "Listening…",
  composing: "Composing…",
  shaping: "Shaping…",
}

export function thinkingStyle(
  style: ComponentProps<"canvas">["style"],
  size: ThinkingSize,
): ComponentProps<"canvas">["style"] {
  const base = `display:block;width:${size}px;height:${size}px`
  if (!style) return base
  if (typeof style === "string") return `${base};${style}`
  return { display: "block", width: `${size}px`, height: `${size}px`, ...style }
}

export function ariaHidden(value: ComponentProps<"canvas">["aria-hidden"]) {
  return value === true || value === "true"
}
