// Ported from thinking-orbs at commit eda2d708b99ab871993bbea5a5f08d23a14da436.
// Copyright (c) 2026 Jakub Antalik. MIT licensed; see THIRD_PARTY_LICENSE.txt.

import type { ModeOpts } from "./profiles"

export type { Dot } from "./core"

/** One frame painter: draws a mode into a 2D context at CSS-pixel size. */
export type ModeDraw = (
  ctx: CanvasRenderingContext2D,
  size: number,
  time: number,
  dark: boolean,
  opts: ModeOpts,
) => void
