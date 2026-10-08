import { lazy, Show, Suspense, Match, Switch } from "solid-js"
import { BasicTool } from "./basic-tool"
import type { ToolProps } from "./message-part"
import { visualizationIsHtml } from "./visualization-data"

const SafeHtmlViewer = lazy(() => import("./safehtml-viewer"))
const VisualizationViewer = lazy(() => import("./visualization-viewer"))
const AnimationViewer = lazy(() => import("./animation-viewer"))

export function InlineVisualizationTool(props: ToolProps) {
  const html = () => visualizationIsHtml(props.tool, props.metadata)
  return (
    <BasicTool
      {...props}
      defer
      icon="code"
      hideDetails={false}
      defaultOpen={props.defaultOpen ?? true}
      trigger={{ title: props.tool === "animate" ? "Animation" : "Visualization" }}
    >
      <Show when={props.status === "completed"}>
        <Suspense fallback={<p role="status">Loading visualization...</p>}>
          <Switch>
            <Match when={props.tool === "animate"}>
              <AnimationViewer metadata={props.metadata} />
            </Match>
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
