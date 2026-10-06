# In-App Visualizations

The `visualize` tool displays an interactive chart inside a session. It accepts data, not executable content.

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
- The renderer uses native SVG and text. It does not execute supplied HTML, JavaScript, or CSS.
- Charts cannot load URLs, access files, or call tools. Filtering and item inspection stay local.
- Each tool result stores its chart data in the session transcript. A later call creates a new chart.
- This version has one value per item. It does not support arbitrary dashboards, executable widgets, or multiple series.

The renderer supports search, group filters, item inspection, and a table view. It mounts through the existing deferred tool-body path.
