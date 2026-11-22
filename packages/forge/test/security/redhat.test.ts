import { describe, expect, test } from "bun:test"
import { RedHat, summarizeRedHatCve } from "../../src/security/integrations/data-vulnerability/redhat"
import { ToolError } from "../../src/security/types"

const cve = "CVE-2026-900001"
const cpe = "cpe:/o:redhat:enterprise_linux:9"
const product = "Red Hat Enterprise Linux 9"
const fixedProduct = "Red Hat Enterprise Linux 9.6 Extended Update Support"
const advisory = "RHSA-2026:9001"

describe("Red Hat CVE summary", () => {
  test("keeps product status separate from shipped fixes and omits raw fields", () => {
    const result = summarizeRedHatCve(
      {
        name: cve,
        details: ["Upstream details"],
        package_state: [
          { product_name: product, package_name: "example", fix_state: "Affected", cpe, upstream_only: "omitted" },
        ],
        affected_release: [
          {
            product_name: fixedProduct,
            package: "example-1.2.3-4.el9_6",
            advisory,
            cpe,
            release_date: "2026-01-01T00:00:00Z",
          },
          { product_name: "Red Hat Enterprise Linux 10", advisory: "RHSA-2026:9002" },
        ],
      },
      cve,
    )

    expect(result).toEqual({
      cve,
      source: "Red Hat Product Security",
      sourceUrl: `https://access.redhat.com/hydra/rest/securitydata/cve/${cve}.json`,
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      found: true,
      packageStates: [{ product, package: "example", status: "Affected", cpe }],
      releasedFixes: [
        {
          product: fixedProduct,
          fixedPackage: "example-1.2.3-4.el9_6",
          advisory,
          advisoryUrl: "https://access.redhat.com/errata/RHSA-2026:9001",
          cpe,
        },
        {
          product: "Red Hat Enterprise Linux 10",
          fixedPackage: undefined,
          advisory: "RHSA-2026:9002",
          advisoryUrl: "https://access.redhat.com/errata/RHSA-2026:9002",
          cpe: undefined,
        },
      ],
      packageStatesTotal: 1,
      releasedFixesTotal: 2,
      truncated: false,
      applicability: "unknown",
    })
  })

  test("returns empty lists when the vendor omits them", () => {
    expect(summarizeRedHatCve({ name: cve }, cve)).toMatchObject({
      cve,
      found: true,
      packageStates: [],
      releasedFixes: [],
      packageStatesTotal: 0,
      releasedFixesTotal: 0,
      truncated: false,
      applicability: "unknown",
    })
  })

  test.each([
    ["null record", null],
    ["missing name", {}],
    ["mismatched name", { name: "CVE-2026-900002" }],
    ["invalid package state list", { name: cve, package_state: {} }],
    ["missing package status", { name: cve, package_state: [{ product_name: "Red Hat", package_name: "example" }] }],
    ["invalid release list", { name: cve, affected_release: "none" }],
    ["missing advisory", { name: cve, affected_release: [{ product_name: "Red Hat" }] }],
  ] as const)("rejects a vendor record with %s", (_, value) => {
    const summarize = () => summarizeRedHatCve(value, cve)
    expect(summarize).toThrow(ToolError)
    expect(summarize).toThrow(/invalid/i)
  })

  test.each([
    [20, 20, false],
    [21, 20, true],
    [20, 22, true],
  ] as const)("bounds %i product states and %i fixes and reports truncation as %p", (states, fixes, truncated) => {
    const result = summarizeRedHatCve(
      {
        name: cve,
        package_state: Array.from({ length: states }, (_, index) => ({
          product_name: product,
          package_name: `example-${index}`,
          fix_state: "Affected",
        })),
        affected_release: Array.from({ length: fixes }, (_, index) => ({
          product_name: product,
          advisory: `RHSA-2026:${9000 + index}`,
        })),
      },
      cve,
    )

    expect(result.packageStates).toHaveLength(20)
    expect(result.releasedFixes).toHaveLength(20)
    expect(result.packageStates.at(-1)?.package).toBe("example-19")
    expect(result.releasedFixes.at(-1)?.advisory).toBe("RHSA-2026:9019")
    expect(result).toMatchObject({ packageStatesTotal: states, releasedFixesTotal: fixes, truncated })
  })
})

describe("Red Hat CVE lookup", () => {
  test.each([
    {},
    { cve: 900001 },
    { cve: "CVE-2026-123" },
    { cve: `../${cve}` },
    { cve: `${cve}%2f` },
    { cve, product: "example" },
  ])("rejects invalid arguments %p before using the cache", async (args) => {
    let cacheReads = 0
    const context = {
      workspace: ".",
      get cacheDir(): string {
        cacheReads++
        throw new Error("Invalid arguments must not reach the cache")
      },
      secrets: {},
    }
    const request = { signal: new AbortController().signal, progress: async () => {} }

    await expect(RedHat.tools[0]!.handler(args, context, request)).rejects.toBeInstanceOf(ToolError)
    expect(cacheReads).toBe(0)
  })
})
