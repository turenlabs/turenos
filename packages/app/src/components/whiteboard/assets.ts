// Bundled modules live in assets/. Absolute URLs also avoid Excalidraw's
// location.origin-based normalization, which cannot resolve file: origins.
export function whiteboardFontBase(development: boolean, base: string, pageURL: string, moduleURL: string) {
  return development ? new URL(`${base}excalidraw/`, pageURL).href : new URL("../excalidraw/", moduleURL).href
}
