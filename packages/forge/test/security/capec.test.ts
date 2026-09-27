import path from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { Capec, parseCatalog } from "../../src/security/integrations/data-knowledge/capec"

const sample = `<?xml version="1.0"?>
<Attack_Pattern_Catalog Version="3.9" Date="2023-01-24">
  <Attack_Patterns>
    <Attack_Pattern ID="66" Name="SQL Injection" Abstraction="Standard" Status="Draft">
      <Description>Attacker-supplied data &amp; a database query.</Description>
      <Extended_Description>Untrusted input is interpreted as query structure.</Extended_Description>
      <Likelihood_Of_Attack>High</Likelihood_Of_Attack>
      <Typical_Severity>Very High</Typical_Severity>
      <Prerequisites><Prerequisite>The application accepts untrusted input.</Prerequisite></Prerequisites>
      <Related_Attack_Patterns><Related_Attack_Pattern Nature="ChildOf" CAPEC_ID="100" /></Related_Attack_Patterns>
      <Mitigations><Mitigation><xhtml:p xmlns:xhtml="http://www.w3.org/1999/xhtml">Use parameterized queries.</xhtml:p></Mitigation></Mitigations>
      <Related_Weaknesses><Related_Weakness CWE_ID="89" /></Related_Weaknesses>
    </Attack_Pattern>
  </Attack_Patterns>
</Attack_Pattern_Catalog>`

describe("MITRE CAPEC parser", () => {
  test("parses bounded defensive fields, XML entities, and taxonomy links", () => {
    expect(parseCatalog(sample)).toEqual({
      version: "3.9",
      date: "2023-01-24",
      patterns: [
        {
          id: 66,
          name: "SQL Injection",
          abstraction: "Standard",
          status: "Draft",
          description: "Attacker-supplied data & a database query.",
          extendedDescription: "Untrusted input is interpreted as query structure.",
          likelihood: "High",
          typicalSeverity: "Very High",
          prerequisites: ["The application accepts untrusted input."],
          mitigations: ["Use parameterized queries."],
          weaknessIDs: [89],
          relatedPatternIDs: [100],
        },
      ],
    })
  })

  test("rejects non-CAPEC and malformed or truncated catalogs", () => {
    expect(() => parseCatalog("<html>temporarily unavailable</html>")).toThrow("invalid XML catalog")
    expect(() => parseCatalog(sample.replace("</Attack_Pattern_Catalog>", ""))).toThrow("invalid XML catalog")
    expect(() =>
      parseCatalog(sample.replace("</Attack_Pattern_Catalog>", "<!-- </Attack_Pattern_Catalog> -->")),
    ).toThrow("invalid XML catalog")
    expect(() =>
      parseCatalog(sample.replace("</Attack_Pattern_Catalog>", "</Attack_Pattern_Catalog><Unexpected />")),
    ).toThrow("invalid XML catalog")
    expect(() =>
      parseCatalog(
        sample.replace(
          "</Attack_Patterns>",
          '<Attack_Pattern ID="66" Name="Duplicate" /></Attack_Patterns>',
        ),
      ),
    ).toThrow("invalid XML catalog")
  })

  test("returns attribution, license, and disclaimer with lookup and search results", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "turen-capec-"))
    try {
      await writeFile(
        path.join(directory, "text:capec-latest-xml.json"),
        JSON.stringify({ expires: Date.now() + 60_000, value: sample }),
      )
      const context = { workspace: directory, cacheDir: directory, secrets: {} }
      const request = { signal: AbortSignal.timeout(5_000), progress: async () => {} }
      const lookup = await Capec.tools[0]!.handler({ id: "CAPEC-66" }, context, request)
      const search = await Capec.tools[1]!.handler({ query: "SQL Injection" }, context, request)

      for (const result of [lookup, search]) {
        expect(result).toMatchObject({
          source: "MITRE CAPEC",
          attribution: expect.stringContaining("The MITRE Corporation"),
          license: expect.stringContaining("commercial purposes"),
          disclaimer: expect.stringContaining('"AS IS" BASIS'),
        })
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
