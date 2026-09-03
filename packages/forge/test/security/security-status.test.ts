import { expect, test, beforeEach } from "bun:test"
import { SecurityRegistry } from "@/security/registry"
import { resetBatouDownloadState } from "@/security/batou-binary"
import { integrationStatusExtras } from "@/server/routes/instance/httpapi/handlers/security"

/** Reset the download single-flight/backoff so Batou reads a clean lifecycle. */
beforeEach(() => resetBatouDownloadState())

const BATOU_STATUSES = ["not-installed", "downloading", "installed", "failed"] as const

test("only Batou carries lifecycle status fields; other tools report just installed", async () => {
  const batou = SecurityRegistry.integration("batou")!
  const batouExtras = await integrationStatusExtras(batou)
  expect(BATOU_STATUSES).toContain(batouExtras.status!)
  expect(typeof batouExtras.installed).toBe("boolean")
  // installed is derived from the lifecycle status, never contradicting it.
  expect(batouExtras.installed).toBe(batouExtras.status === "installed")

  // A different "tools" integration reports installability but no lifecycle.
  const gitleaks = SecurityRegistry.integration("gitleaks")!
  const gitleaksExtras = await integrationStatusExtras(gitleaks)
  expect(typeof gitleaksExtras.installed).toBe("boolean")
  expect(gitleaksExtras.status).toBeUndefined()
  expect(gitleaksExtras.statusDetail).toBeUndefined()
})

test("data integrations report no install or lifecycle fields at all", async () => {
  const osv = SecurityRegistry.integration("osv")!
  expect(osv.category).toBe("data")
  expect(await integrationStatusExtras(osv)).toEqual({})
})
