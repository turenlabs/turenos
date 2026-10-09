# Inline HTML visualizations

The `visualize` tool displays HTML inside a chat message. The `animate` tool adds bounded numeric and color tracks to sanitized HTML.
Neither tool accepts agent JavaScript. Both tools are advertised by default, but explicit permission rules still apply.

## Delivery and style

After an example, screenshot, correction, or data change, agents must render the updated view in the current reply.
An older card is not a substitute. Put explanations before the visualization and keep text after it brief.
If a view is missing, try a fresh render or report the failure.

Use one compact title, system typography, aligned labels, tight spacing, and flat neutral surfaces.
Avoid gradients, oversized headings, badge rows, and repeated rounded cards.
Use muted colors to explain data. Preserve units, legends, source notes, and uncertainty.

## Static HTML

Supply `version: 1`, `title`, optional `description`, and `html` to `visualize`.
HTML takes precedence when the payload contains HTML and chart fields.
Use self-contained HTML, inline CSS, and SVG for diagrams, tables, charts, and visual explanations.

The renderer sanitizes the HTML and places it in an inline frame with an empty sandbox permission list.
A Content Security Policy blocks scripts and external resources. Styles cannot change the app.
Native `details` and `summary` elements support expandable sections.
Checkbox and radio controls can use CSS for local interaction.
Agent scripts, event handlers, links, embeds, forms, and resource URLs are removed or blocked.

Persisted `safehtml` results retain their renderer. New tool calls use `visualize`; `safehtml` is not advertised or executable.

## Bounded animation

Supply `version: 1`, `title`, optional `description`, `html`, and `tracks` to `animate`.
Each track names one literal element ID and one supported property.
Targets are not CSS selectors. Tracks contain keyframes, `duration`, and optional `at`, all with schema validation.
Missing `at` means zero milliseconds.

The trusted renderer uses Anime.js 4.5.0 under the MIT license.
It consumes numeric and hexadecimal color tracks, not arbitrary JavaScript.
The inline sandbox allows only the trusted runtime script. It does not gain the app bridge or same-origin access.
The animation starts paused and uses linear timing.
Use faithful durations for scientific motion. Label illustrative motion and preserve measured values.

No track can request autoplay, loops, callbacks, selectors, URLs, or arbitrary properties.
HTML sanitization still removes agent scripts and event handlers.
The trusted runtime does not make supplied HTML executable.

## Limits

| Field                          | Limit                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| Encoded HTML or animation JSON | 512 KiB of UTF-8 bytes                                                               |
| Title                          | 1–160 characters                                                                     |
| Description                    | At most 1,000 characters                                                             |
| Sanitized document             | At most 5,000 elements                                                               |
| Animation tracks               | 1–128                                                                                |
| Target ID                      | At most 120 characters; starts with an ASCII letter, then word characters or hyphens |
| Keyframes per track            | 2–32                                                                                 |
| Duration                       | 100–60,000 milliseconds                                                              |
| Start time `at`                | 0–60,000 milliseconds; track must finish by 60,000                                   |
| Numeric keyframes              | Finite; absolute value at most 1,000,000                                             |
| Opacity                        | 0–1                                                                                  |
| Scale                          | 0–100                                                                                |
| Radius, width, height          | 0–10,000                                                                             |
| Color keyframes                | `#RGB` or `#RRGGBB` only                                                             |

Numeric properties are `x`, `y`, `translateX`, `translateY`, `rotate`, `scale`, `opacity`, `cx`, `cy`, `r`,
`width`, `height`, `strokeDashoffset`, and `textContent`. Color properties are `fill` and `stroke`.
Size and element limits bound input size, not rendering time.

For data charts and local filtering, see [Visualizations](./visualization-tool.md).

## Verification

Schema tests cover target IDs, keyframes, numeric ranges, colors, timing, and encoded byte limits.
Core tool tests cover default advertisement, structured metadata, compact model output, and permission denial.
Renderer tests and live sandbox probes cover the separate UI boundary.

## Source

- [`packages/core/src/tool/visualize.ts`](../../packages/core/src/tool/visualize.ts)
- [`packages/core/src/tool/animate.ts`](../../packages/core/src/tool/animate.ts)
- [`packages/core/src/tool/visualization-guidance.ts`](../../packages/core/src/tool/visualization-guidance.ts)
- [`packages/schema/src/safehtml.ts`](../../packages/schema/src/safehtml.ts)
- [`packages/schema/src/animation.ts`](../../packages/schema/src/animation.ts)
- [`packages/session-ui/src/components/safehtml-sanitize.ts`](../../packages/session-ui/src/components/safehtml-sanitize.ts)
- [`packages/session-ui/src/components/safehtml-viewer.tsx`](../../packages/session-ui/src/components/safehtml-viewer.tsx)
- [`packages/session-ui/src/components/animation-data.ts`](../../packages/session-ui/src/components/animation-data.ts)
- [`packages/session-ui/src/components/animation-document.ts`](../../packages/session-ui/src/components/animation-document.ts)
- [`packages/session-ui/src/components/animation-runtime.ts`](../../packages/session-ui/src/components/animation-runtime.ts)
