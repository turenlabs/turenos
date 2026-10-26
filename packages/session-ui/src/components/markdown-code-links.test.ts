import { expect, test } from "bun:test"
import { markedExternalLink } from "@turenlabs/ui/context/marked"
import { JSDOM } from "jsdom"
import { Marked } from "marked"
import { markCodeLinks } from "./markdown-code-links"

const attributes = 'class="external-link" target="_blank" rel="noopener noreferrer"'

async function render(markdown: string) {
  const root = new JSDOM("").window.document.createElement("div")
  root.innerHTML = await new Marked(markedExternalLink).parse(markdown)
  markCodeLinks(root)
  return root.innerHTML
}

test("keeps the link and href a Markdown label wrote around inline code", async () => {
  expect(await render("[`src/app.ts`](src/app.ts)")).toBe(
    `<p><a href="src/app.ts" ${attributes}><code>src/app.ts</code></a></p>\n`,
  )
  expect(await render("[`https://a.example.com`](https://b.example.com)")).toBe(
    `<p><a href="https://b.example.com" ${attributes}><code>https://a.example.com</code></a></p>\n`,
  )
  expect(await render("[**`https://a.example.com`**](https://b.example.com)")).toBe(
    `<p><a href="https://b.example.com" ${attributes}><strong><code>https://a.example.com</code></strong></a></p>\n`,
  )
})

test("links inline code that is a bare URL", async () => {
  expect(await render("See `https://plain.example.com` and `src/plain.ts`.")).toBe(
    `<p>See <a href="https://plain.example.com/" ${attributes}><code>https://plain.example.com</code></a> and <code>src/plain.ts</code>.</p>\n`,
  )
})
