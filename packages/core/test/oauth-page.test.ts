import { describe, expect, test } from "bun:test"
import { OauthCallbackPage } from "../src/oauth/page"

describe("OauthCallbackPage", () => {
  test.each([
    ["success", OauthCallbackPage.success({ provider: "ChatGPT", autoClose: false })],
    ["error", OauthCallbackPage.error("Access denied", { provider: "ChatGPT" })],
    ["pending", OauthCallbackPage.bootstrap({ provider: "DigitalOcean", tokenPath: "/oauth/token" })],
  ])("renders the TurenOS brand in the %s state", (_, html) => {
    expect(html).toContain(`aria-label="TurenOS"`)
    expect(html).toContain(`<img class="wordmark" src="data:image/png;base64,`)
    expect(html).not.toContain("opencode")
  })

  test("uses TurenOS copy for success and failure pages", () => {
    const success = OauthCallbackPage.success({ provider: "ChatGPT", autoClose: false })
    const failure = OauthCallbackPage.error("Access denied", { provider: "ChatGPT" })

    expect(success).toContain("Authorization successful · TurenOS")
    expect(success).toContain("TurenOS is now connected to ChatGPT.")
    expect(failure).toContain("Authorization failed · TurenOS")
    expect(failure).toContain("TurenOS couldn't finish connecting to ChatGPT.")
    expect(failure).toContain("try again from TurenOS.")
  })

  test("escapes bootstrap options embedded in the inline script", () => {
    const html = OauthCallbackPage.bootstrap({
      provider: `xAI</script><script>alert("provider")</script>`,
      tokenPath: `/token</script><script>alert("path")</script>`,
    })

    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain(`xAI\\u003c/script>\\u003cscript>alert(\\\"provider\\\")\\u003c/script>`)
    expect(html).toContain(`/token\\u003c/script>\\u003cscript>alert(\\\"path\\\")\\u003c/script>`)
  })
})
