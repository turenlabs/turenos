# Safe HTML in Chat

The `safehtml` tool displays agent-authored HTML directly inside a chat message. It does not open another window.

The tool is enabled and advertised by default. Agents do not need to search for it or load it. Explicit permission rules still apply.

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
  "html": "<style>section{padding:20px;border-radius:12px;background:#e0f2fe;color:#0c4a6e}strong{font-size:32px}</style><section><strong>240</strong><p>Lines of source</p><details><summary>How to read this view</summary><p>This number is illustrative.</p></details></section>"
}
```

Use measured data when describing a workspace. Include units, labels, and source notes. Design for narrow screens. Do not add controls that need JavaScript.

The existing `visualize` tool remains available for charts with local scripted filtering and item inspection.
