import { describe, expect, test } from "bun:test"
import { parseEvent, parseManifest } from "../../src/security/integrations/data-certfr/certfr-misp"
import { validateManifest } from "../../src/security/integrations/data-supply/datadog-malicious"

const uuid = "12345678-1234-1234-1234-123456789abc"
const org = { name: "CERT-FR", uuid: "56bdf779-46f8-4353-bdf9-2bb95bce2212" }
const tags = [{ name: "tlp:clear" }, { name: "PAP:CLEAR" }]

describe("CERT-FR and Datadog TI parsers", () => {
  test("requires CERT-FR TLP:CLEAR metadata", () => {
    expect(
      parseManifest({
        [uuid]: { info: "Campaign", date: "2026-08-27", Orgc: org, Tag: tags, timestamp: "1" },
      }),
    ).toEqual([expect.objectContaining({ uuid, info: "Campaign", tlp: ["tlp:clear"], pap: ["PAP:CLEAR"] })])
    expect(() =>
      parseManifest({ [uuid]: { info: "Private", date: "2026-08-27", Orgc: org, Tag: [{ name: "tlp:amber" }] } }),
    ).toThrow("not marked TLP:CLEAR")
  })

  test("accepts MISP events without optional direct or object attributes", () => {
    expect(
      parseEvent(
        { Event: { uuid, info: "Campaign", date: "2026-08-27", Orgc: org, Tag: tags, published: true } },
        uuid,
      ),
    ).toMatchObject({ uuid, attributes: [], attributesTotal: 0, published: true })
  })

  test("rejects malformed Datadog manifests", () => {
    expect(validateManifest({ "malicious-skill": null, "bad-extension": ["1.0.0"] })).toEqual({
      "malicious-skill": null,
      "bad-extension": ["1.0.0"],
    })
    expect(() => validateManifest({})).toThrow("empty")
    expect(() => validateManifest({ bad: [1] })).toThrow("invalid version data")
  })
})
