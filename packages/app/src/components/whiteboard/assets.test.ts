import { expect, test } from "bun:test"
import { whiteboardFontBase } from "./assets"

test("font roots stay local on nested development, web, and desktop routes", () => {
  expect(whiteboardFontBase(true, "/nested/", "http://localhost:4444/nested/session/123", "unused")).toBe("http://localhost:4444/nested/excalidraw/")
  expect(whiteboardFontBase(false, "./", "file:///app/server/123/session/456", "file:///app/assets/whiteboard.js")).toBe("file:///app/excalidraw/")
  expect(whiteboardFontBase(false, "./", "app://local/server/123/session/456", "app://local/assets/whiteboard.js")).toBe("app://local/excalidraw/")
  expect(whiteboardFontBase(false, "/nested/", "https://app.test/nested/session/123", "https://app.test/nested/assets/whiteboard.js")).toBe("https://app.test/nested/excalidraw/")
})
