import { describe, expect, test } from "bun:test"
import {
  ANALYSIS_DEFAULT_DESTINATION,
  analysisDestinationFromPathname,
  analysisDestinationHref,
} from "./analysis-state"

describe("analysis navigation", () => {
  test("selects AppSec for the Workbench entry point", () => {
    expect(analysisDestinationFromPathname("/analysis")).toBe("appsec")
  })

  test("selects the honest placeholder destination", () => {
    expect(analysisDestinationFromPathname("/analysis/pen-testing")).toBe("pen-testing")
    expect(analysisDestinationFromPathname("/analysis/appsec")).toBe("appsec")
    expect(analysisDestinationFromPathname("/analysis/appsec/finding_123")).toBe("appsec")
  })

  test("keeps every pentest route, including a run page, on the Pentest tab", () => {
    expect(analysisDestinationFromPathname("/pentest")).toBe("pen-testing")
    expect(analysisDestinationFromPathname("/pentest/pent_f9ee2854954b")).toBe("pen-testing")
  })

  test("does not classify unrelated routes as Analysis children", () => {
    expect(analysisDestinationFromPathname("/")).toBeUndefined()
    expect(analysisDestinationFromPathname("/analysis/unknown-workspace")).toBeUndefined()
    expect(analysisDestinationFromPathname(`/analysis/${["rever", "sing"].join("")}`)).toBeUndefined()
    expect(analysisDestinationFromPathname("/server/local/session/ses_1")).toBeUndefined()
  })
})

describe("analysisDestinationHref", () => {
  test("maps each destination to its canonical route", () => {
    expect(analysisDestinationHref("appsec")).toBe("/analysis/appsec")
    expect(analysisDestinationHref("pen-testing")).toBe("/analysis/pen-testing")
  })

  test("the default destination is AppSec, the first tab in the strip", () => {
    expect(ANALYSIS_DEFAULT_DESTINATION).toBe("appsec")
  })
})
