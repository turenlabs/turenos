import { expect, test } from "bun:test"
import { Marked } from "marked"
import { markedExternalLink } from "./marked"

const attributes = 'class="external-link" target="_blank" rel="noopener noreferrer"'

test("renders link labels as inline Markdown", async () => {
  const marked = new Marked(markedExternalLink)

  expect(await marked.parse("[`src/app.ts`](src/app.ts)")).toBe(
    `<p><a href="src/app.ts" ${attributes}><code>src/app.ts</code></a></p>\n`,
  )
  expect(await marked.parse("[**bold** link](https://example.com)")).toBe(
    `<p><a href="https://example.com" ${attributes}><strong>bold</strong> link</a></p>\n`,
  )
  expect(await marked.parse("[![build](https://img.shields.io/badge/x.svg)](https://ci.example.com)")).toBe(
    `<p><a href="https://ci.example.com" ${attributes}><img src="https://img.shields.io/badge/x.svg" alt="build"></a></p>\n`,
  )
})

test("escapes link labels, hrefs, and titles", async () => {
  const marked = new Marked(markedExternalLink)

  expect(await marked.parse("See [a<b and c](https://example.com) for details.")).toBe(
    `<p>See <a href="https://example.com" ${attributes}>a&lt;b and c</a> for details.</p>\n`,
  )
  expect(await marked.parse('[x](https://example.com "say \\"hi\\" now")')).toBe(
    `<p><a href="https://example.com" title="say &quot;hi&quot; now" ${attributes}>x</a></p>\n`,
  )
  expect(await marked.parse('[x](<https://example.com/a"b>)')).toBe(
    `<p><a href="https://example.com/a%22b" ${attributes}>x</a></p>\n`,
  )
})
