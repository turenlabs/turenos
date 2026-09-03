import { describe, expect, test } from "bun:test"
import { trimVuln } from "../../src/security/integrations/osv"

describe("OSV malicious-package projection", () => {
  test("preserves bounded OpenSSF origins and evidence hashes", () => {
    const record = trimVuln({
      id: "MAL-2026-1",
      summary: "Malicious code in package",
      database_specific: {
        "malicious-packages-origins": [
          { source: "ghsa-malware", id: "GHSA-test", versions: ["1.0.0"], sha256: "a".repeat(64) },
        ],
        iocs: { files: [{ paths: ["setup.mjs"], note: "install-time loader" }] },
      },
      affected: [
        {
          package: { name: "malicious-package", ecosystem: "npm" },
          database_specific: {
            indicators: { evidence_files: [{ path: "payload.js", sha256: "b".repeat(64), tlsh: "t1hash" }] },
          },
        },
      ],
    })

    expect(record).toMatchObject({
      id: "MAL-2026-1",
      classification: "malicious-package",
      maliciousOrigins: [{ source: "ghsa-malware", id: "GHSA-test", versions: ["1.0.0"] }],
      evidenceFiles: [
        { path: "setup.mjs", note: "install-time loader" },
        { path: "payload.js", sha256: "b".repeat(64), tlsh: "t1hash" },
      ],
    })
  })

  test("bounds evidence expansion before projecting large path lists", () => {
    const record = trimVuln({
      id: "MAL-2026-many-files",
      database_specific: {
        iocs: { files: [{ paths: Array.from({ length: 10_000 }, (_, index) => `file-${index}.js`) }] },
      },
    })
    expect(record.evidenceFiles).toHaveLength(20)
    expect(record.evidenceFiles?.at(-1)?.path).toBe("file-19.js")
  })
})
