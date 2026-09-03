import { type ComponentProps } from "solid-js"
import mark from "../assets/brand/turen-mark.png"

/**
 * TurenOS brand marks.
 *
 * The mark is square, so every surface that sizes it by width (`w-10`, `w-20`)
 * gets a matching height. The wordmark reserves natural width for TurenOS so
 * its letters are not compressed by SVG textLength fitting.
 */

const MARK_BOX = "0 0 1024 1024"

export const Mark = (props: ComponentProps<"svg">) => {
  return (
    <svg
      {...props}
      data-component="logo-mark"
      class={props.class}
      aria-hidden={props["aria-label"] ? undefined : (props["aria-hidden"] ?? "true")}
      role={props.role ?? (props["aria-label"] ? "img" : undefined)}
      viewBox={MARK_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <image aria-hidden="true" data-slot="logo-mark-art" width="1024" height="1024" href={mark} />
    </svg>
  )
}

export const Splash = (props: ComponentProps<"svg">) => {
  return (
    <svg
      {...props}
      data-component="logo-splash"
      class={props.class}
      aria-hidden={props["aria-label"] ? undefined : (props["aria-hidden"] ?? "true")}
      role={props.role ?? (props["aria-label"] ? "img" : undefined)}
      viewBox={MARK_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <image aria-hidden="true" data-slot="logo-splash-art" width="1024" height="1024" href={mark} />
    </svg>
  )
}

export const Logo = (props: ComponentProps<"svg">) => {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      data-component="logo-wordmark"
      viewBox="0 0 960 340"
      class={props.class}
      aria-hidden={props["aria-label"] ? undefined : (props["aria-hidden"] ?? "true")}
      role={props.role ?? (props["aria-label"] ? "img" : undefined)}
    >
      <image aria-hidden="true" data-slot="logo-wordmark-art" x="8" y="20" width="300" height="300" href={mark} />
      <text
        aria-hidden="true"
        data-slot="logo-wordmark-text"
        x="330"
        y="228"
        fill="currentColor"
        font-family="var(--font-family-sans), Inter, system-ui, sans-serif"
        font-size="150"
        font-weight="600"
        letter-spacing="-3"
      >
        TurenOS
      </text>
    </svg>
  )
}
