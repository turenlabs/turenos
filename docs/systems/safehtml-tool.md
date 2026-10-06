# Safe HTML in Chat

The `safehtml` tool displays agent-authored HTML directly inside a chat message. It does not open another window.

The tool is enabled and advertised by default. Agents do not need to search for it or load it. Explicit permission rules still apply.

## Delivery and Style

After an example, screenshot, correction, or data change, agents should render the updated view in the current reply. An older card is not a substitute. Put explanations before the visualization and keep text after it brief. If a view is missing, try a fresh render or report the failure.

Use the app's restrained visual style. Keep one compact title, system typography, aligned labels, tight spacing, and flat neutral surfaces. Avoid gradient backgrounds, oversized headings, badge rows, and repeated rounded cards. Use muted colors to explain data, not to decorate the page. Keep units, legends, source notes, and uncertainty visible.

## Supported Content

Supply `version: 1`, `title`, optional `description`, and `html`. Use HTML, inline CSS, and SVG to build diagrams, dashboards, charts, tables, and visual explanations.

The renderer sanitizes the HTML and places it in an inline frame with an empty sandbox permission list. A Content Security Policy blocks scripts and external resources. Styles stay inside the frame and cannot change the app.

Native interactions work without scripts. Use `details` and `summary` for expandable sections. Use checkbox or radio controls with CSS selectors for toggles. JavaScript, event handlers, links, embeds, forms, and resource URLs are removed or blocked.

Keep the total encoded payload below 512 KiB. The renderer also limits each document to 5,000 elements. These limits bound input size, not rendering time.

## Example

```json
{
  "version": 1,
  "title": "Source Summary",
  "description": "Example values, not workspace measurements.",
  "html": "<style>table{border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:6px 12px;text-align:left;border-bottom:1px solid #8886}th{font-weight:600}</style><table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody><tr><td>Lines of source</td><td>240</td></tr></tbody></table><details><summary>Source notes</summary><p>This number is illustrative.</p></details>"
}
```

Use measured data when describing a workspace. Include units, labels, and source notes. Design for narrow screens. Do not add controls that need JavaScript.

The existing [visualize tool](./visualization-tool.md) remains available for charts with local scripted filtering and item inspection.

## Source

- [`packages/core/src/tool/safehtml.ts`](../../packages/core/src/tool/safehtml.ts)
- [`packages/schema/src/safehtml.ts`](../../packages/schema/src/safehtml.ts)
- [`packages/session-ui/src/components/safehtml-sanitize.ts`](../../packages/session-ui/src/components/safehtml-sanitize.ts)
- [`packages/session-ui/src/components/safehtml-viewer.tsx`](../../packages/session-ui/src/components/safehtml-viewer.tsx)
