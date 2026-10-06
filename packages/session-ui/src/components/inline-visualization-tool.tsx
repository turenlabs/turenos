import { lazy, Show, Suspense, Match, Switch } from "solid-js"
import { BasicTool } from "./basic-tool"
import type { ToolProps } from "./message-part"

const SafeHtmlViewer = lazy(() => import("./safehtml-viewer"))
const VisualizationViewer = lazy(() => import("./visualization-viewer"))

export function InlineVisualizationTool(props: ToolProps) {
  const html = () => props.tool === "safehtml"
  return (
    <BasicTool
      {...props}
      defer
      icon="code"
      hideDetails={false}
      defaultOpen={props.defaultOpen ?? true}
      trigger={{ title: html() ? "Safe HTML" : "Visualization" }}
    >
      <Show when={props.status === "completed"}>
        <Suspense fallback={<p role="status">Loading visualization...</p>}>
          <Switch>
            <Match when={html()}>
              <SafeHtmlViewer metadata={props.metadata} />
            </Match>
            <Match when={!html()}>
              <VisualizationViewer metadata={props.metadata} />
            </Match>
          </Switch>
        </Suspense>
      </Show>
    </BasicTool>
  )
}
