# Inline visualizations

The `visualize` tool displays HTML or an interactive data chart inside a session.
The `animate` tool displays sanitized HTML with bounded numeric and color tracks.
Both tools are advertised by default. Explicit permission rules still apply.

Supply `html` for a custom visual explanation. HTML takes precedence over chart fields when both are present.
For HTML sanitization and animation limits, see [Inline HTML visualizations](./safehtml-tool.md).

After examples or revisions, agents must render the updated view in the current reply.
Use restrained, flat styling. Do not direct the user to an older card.

Use `bar` to compare values, `line` to show an ordered sequence, or `treemap` to compare relative sizes. Line charts use item order, not dates or numeric coordinates, for the horizontal axis. Treemap area represents each item's value.

Example tool input:

```json
{
  "version": 1,
  "title": "Source File Sizes",
  "kind": "treemap",
  "unit": "lines",
  "items": [
    { "label": "server.ts", "value": 320, "group": "backend" },
    { "label": "router.ts", "value": 180, "group": "backend" },
    { "label": "chat.tsx", "value": 240, "group": "frontend" }
  ]
}
```

These example values are illustrative. Agents must collect real measurements before describing a workspace.

## Limits

- Each chart accepts 1 to 500 items and at most 128 KiB of encoded UTF-8 data.
- Values must be finite numbers between zero and one trillion.
- Labels, descriptions, groups, and item notes have fixed length limits.
- Both the tool and the renderer validate the chart schema.
- The data-chart renderer uses D3 under the ISC license to construct SVG charts from validated data.
- Chart fields contain text and numbers, not executable JavaScript or CSS. HTML uses the separate sanitized frame path.
- Charts cannot load URLs, access files, or call tools. Filtering and item inspection stay local.
- Each tool result stores its chart data in the session transcript. A later call creates a new chart.
- Chart data has one value per item. Use the HTML form for custom layouts, not executable widgets.

The renderer supports search, group filters, item inspection, and a table view. It mounts through the existing deferred tool-body path.

## Source

- [`packages/core/src/tool/visualize.ts`](../../packages/core/src/tool/visualize.ts)
- [`packages/core/src/tool/animate.ts`](../../packages/core/src/tool/animate.ts)
- [`packages/schema/src/visualization.ts`](../../packages/schema/src/visualization.ts)
- [`packages/session-ui/src/components/visualization-viewer.tsx`](../../packages/session-ui/src/components/visualization-viewer.tsx)
- [`packages/session-ui/src/components/visualization-layout.ts`](../../packages/session-ui/src/components/visualization-layout.ts)
