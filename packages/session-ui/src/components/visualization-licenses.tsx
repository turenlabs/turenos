/// <reference path="./animation-virtual.d.ts" />
import notices from "virtual:turen-visualization-licenses"

export function VisualizationLicenses() {
  return (
    <details>
      <summary>Libraries and licenses</summary>
      <pre style={{ "white-space": "pre-wrap", "font-size": "11px", "max-height": "240px", overflow: "auto" }}>
        {notices}
      </pre>
    </details>
  )
}
