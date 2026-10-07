export * as Animation from "./animation"

import { Schema } from "effect"
import { optional } from "./schema"

export const MAX_BYTES = 512 * 1024
export const MAX_TRACKS = 128
export const MAX_DURATION = 60000

const timing = {
  target: Schema.NonEmptyString.check(
    Schema.isMaxLength(120),
    Schema.makeFilter((value) => /^[A-Za-z][\w-]*$/.test(value), { message: "Target must be a literal element ID" }),
  ),
  duration: Schema.Finite.check(Schema.isBetween({ minimum: 100, maximum: MAX_DURATION })),
  at: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: MAX_DURATION }))),
}

export const NumericTrack = Schema.Struct({
  ...timing,
  property: Schema.Literals([
    "x",
    "y",
    "translateX",
    "translateY",
    "rotate",
    "scale",
    "opacity",
    "cx",
    "cy",
    "r",
    "width",
    "height",
    "strokeDashoffset",
    "textContent",
  ]),
  keyframes: Schema.Array(Schema.Finite.check(Schema.isBetween({ minimum: -1e6, maximum: 1e6 }))).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(32),
  ),
}).check(
  Schema.makeFilter(
    (track) =>
      track.keyframes.every((value) => {
        if (track.property === "opacity") return value >= 0 && value <= 1
        if (track.property === "scale") return value >= 0 && value <= 100
        if (["r", "width", "height"].includes(track.property)) return value >= 0 && value <= 10000
        return true
      }),
    { message: "Keyframes exceed the property's numeric range" },
  ),
)
export interface NumericTrack extends Schema.Schema.Type<typeof NumericTrack> {}

export const ColorTrack = Schema.Struct({
  ...timing,
  property: Schema.Literals(["fill", "stroke"]),
  keyframes: Schema.Array(
    Schema.String.check(
      Schema.makeFilter((value) => /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/.test(value), {
        message: "Color must be #RGB or #RRGGBB",
      }),
    ),
  ).check(Schema.isMinLength(2), Schema.isMaxLength(32)),
})
export interface ColorTrack extends Schema.Schema.Type<typeof ColorTrack> {}

export const Track = Schema.Union([NumericTrack, ColorTrack]).check(
  Schema.makeFilter((track) => (track.at ?? 0) + track.duration <= MAX_DURATION, {
    message: "Track must finish within 60000 milliseconds",
  }),
)
export type Track = typeof Track.Type

export const Spec = Schema.Struct({
  version: Schema.Literal(1),
  title: Schema.NonEmptyString.check(Schema.isMaxLength(160)),
  description: optional(Schema.String.check(Schema.isMaxLength(1000))),
  html: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_BYTES)),
  tracks: Schema.Array(Track).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_TRACKS)),
})
  .check(
    Schema.makeFilter((value) => new TextEncoder().encode(JSON.stringify(value)).length <= MAX_BYTES, {
      message: `Animation data must not exceed ${MAX_BYTES} UTF-8 bytes`,
    }),
  )
  .annotate({ identifier: "Animation.Spec" })
export interface Spec extends Schema.Schema.Type<typeof Spec> {}
