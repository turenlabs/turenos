import { expect, spyOn, test } from "bun:test"
import { resolveObjectURL } from "node:buffer"
import { fileSave } from "./download"

test("downloads generated images and scenes without a writable file handle", async () => {
  const downloads: { name: string; blob: Blob; connected: boolean }[] = []
  const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: resolveObjectURL(this.href)!, connected: this.isConnected })
  })
  try {
    for (const [extension, type] of [["png", "image/png"], ["svg", "image/svg+xml"], ["excalidraw", "application/json"]]) {
      const blob = new Blob(["exported content"], { type })
      expect(await fileSave(Promise.resolve(blob), { fileName: `Drawing.${extension}` })).toBeNull()
      const download = downloads.at(-1)!
      expect(download.name).toBe(`Drawing.${extension}`)
      expect(download.connected).toBe(true)
      // Happy DOM's object URL bridge adds a charset to JSON blobs.
      expect(download.blob.type.split(";", 1)[0]).toBe(blob.type.split(";", 1)[0])
      expect(await download.blob.text()).toBe("exported content")
    }
    expect(document.querySelector('a[download^="Drawing."]')).toBeNull()
  } finally {
    click.mockRestore()
  }
})
