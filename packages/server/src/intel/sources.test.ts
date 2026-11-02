import { describe, expect, test } from "bun:test"
import { EPSS_URL, NVD_URL, fetchEpss, fetchNvd, parseRss, type FetchFn } from "./sources"

describe("fetchEpss", () => {
  test("parses FIRST numeric strings and preserves numeric scores", async () => {
    const fetchFn: FetchFn = async (url, init) => {
      expect(url).toBe(`${EPSS_URL}?limit=100`)
      expect(init?.headers).toEqual({ accept: "application/json" })
      return Response.json({
        data: [
          { cve: "CVE-2026-1234", epss: "0.975", percentile: "0.999", date: "2026-09-07" },
          { cve: "CVE-2026-5678", epss: 0.25, percentile: 0.75, date: "2026-09-06" },
        ],
      })
    }

    expect(await fetchEpss(fetchFn)).toEqual([
      { cve: "CVE-2026-1234", epss: 0.975, percentile: 0.999, date: "2026-09-07" },
      { cve: "CVE-2026-5678", epss: 0.25, percentile: 0.75, date: "2026-09-06" },
    ])
  })

  test("retains zero fallbacks for missing, invalid, and non-finite scores", async () => {
    const values = [undefined, null, true, {}, [], "", " ", "invalid", "0.5junk", "NaN", "Infinity", "-Infinity"]
    const fetchFn: FetchFn = async () =>
      Response.json({
        data: values.map((value) => ({ epss: value, percentile: value })),
      })

    expect(await fetchEpss(fetchFn)).toEqual(values.map(() => ({ cve: "", epss: 0, percentile: 0, date: "" })))
  })
})

describe("fetchNvd", () => {
  test.each([
    NVD_URL,
    `${NVD_URL}?keywordSearch=remote%20execution&resultsPerPage=20`,
    `${NVD_URL}?keywordSearch=remote%20execution&lastModStartDate=old&lastModEndDate=old#feed`,
  ])("sets the seven-day window without losing existing URL components: %s", async (baseUrl) => {
    const fetchFn: FetchFn = async (input, init) => {
      const url = new URL(input)
      const original = new URL(baseUrl)
      expect(url.origin).toBe(original.origin)
      expect(url.pathname).toBe(original.pathname)
      expect(url.hash).toBe(original.hash)
      expect(url.searchParams.get("keywordSearch")).toBe(original.searchParams.get("keywordSearch"))
      expect(url.searchParams.get("resultsPerPage")).toBe(original.searchParams.get("resultsPerPage"))
      expect(url.searchParams.getAll("lastModStartDate")).toEqual(["2026-08-31T12:00:00.000Z"])
      expect(url.searchParams.getAll("lastModEndDate")).toEqual(["2026-09-07T12:00:00.000Z"])
      expect(init?.headers).toEqual({ accept: "application/json" })
      return Response.json({
        vulnerabilities: [
          {
            cve: {
              id: "CVE-2026-1234",
              descriptions: [{ lang: "en", value: "A vulnerability" }],
              published: "2026-09-01T00:00:00.000Z",
              lastModified: "2026-09-07T00:00:00.000Z",
              sourceIdentifier: "source@example.com",
              metrics: { cvssMetricV31: [{ cvssData: { baseScore: 9.8, baseSeverity: "CRITICAL" } }] },
            },
          },
        ],
      })
    }

    expect(await fetchNvd(fetchFn, Date.parse("2026-09-07T12:00:00.000Z"), baseUrl)).toEqual([
      {
        id: "CVE-2026-1234",
        description: "A vulnerability",
        published: "2026-09-01T00:00:00.000Z",
        lastModified: "2026-09-07T00:00:00.000Z",
        source: "source@example.com",
        cvss: 9.8,
        severity: "critical",
      },
    ])
  })
})

describe("parseRss", () => {
  test("turns entity-escaped and CDATA-wrapped feed HTML into plain text", () => {
    const xml = `<rss><channel>
<item>
  <title>CISA&#039;s AT&amp;T &#x3f; &#x110000;</title>
  <link>https://e.test/p?a=1&amp;b=2</link>
  <pubDate>Fri, 23 Oct 2026 00:00:00 GMT</pubDate>
  <description>&lt;p&gt;Use &amp;lt;b&amp;gt; &amp;amp; more&lt;/p&gt;</description>
</item>
<item>
  <title><![CDATA[Microsoft &amp; Oracle&#x3f;]]></title>
  <link><![CDATA[https://e.test/q?a=1&b=2]]></link>
  <description><![CDATA[<p>Payload &lt;svg&gt; runs</p>&#xd;]]></description>
</item>
</channel></rss>`

    expect(parseRss(xml)).toEqual([
      {
        title: "CISA's AT&T ? &#x110000;",
        link: "https://e.test/p?a=1&b=2",
        pubDate: "Fri, 23 Oct 2026 00:00:00 GMT",
        description: "Use <b> & more",
      },
      {
        title: "Microsoft & Oracle?",
        link: "https://e.test/q?a=1&b=2",
        pubDate: "",
        description: "Payload <svg> runs",
      },
    ])
  })
})
