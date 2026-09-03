export type AnalysisDestination = "pen-testing" | "appsec"

export function analysisDestinationFromPathname(pathname: string): AnalysisDestination | undefined {
  // Pentest is reachable as the Workbench tab and as its own top-level route, and a run detail
  // page hangs off the latter. All of them are the same destination: miss one and the shell drops
  // its Workbench identity, so the surrounding chrome falls back to the default session nav.
  if (
    pathname === "/analysis/pen-testing" ||
    pathname === "/pentest" ||
    pathname.startsWith("/pentest/") ||
    pathname.startsWith("/analysis/pen-testing/")
  )
    return "pen-testing"
  if (pathname === "/analysis" || pathname === "/analysis/appsec" || pathname.startsWith("/analysis/appsec/"))
    return "appsec"
}

// AppSec is first in the tab strip (see AnalysisShell's `items`), so it is
// also the destination a first-time visitor lands on.
export const ANALYSIS_DEFAULT_DESTINATION: AnalysisDestination = "appsec"

export function analysisDestinationHref(destination: AnalysisDestination): string {
  if (destination === "pen-testing") return "/analysis/pen-testing"
  return "/analysis/appsec"
}
