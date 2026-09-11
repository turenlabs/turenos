import type { SecurityProxy } from "@turenlabs/schema/security-proxy"

declare global {
  interface Window {
    securityBrowser: { invoke(input: { type: string; url?: string }): Promise<SecurityProxy.Result> }
  }
}

const field = document.getElementById("url") as HTMLInputElement
const status = document.getElementById("status")!
const error = document.getElementById("error")!
let polling = false
const invoke = async (type: string, url?: string) => {
  try {
    const result = await window.securityBrowser.invoke({ type, ...(url === undefined ? {} : { url }) })
    const snapshot = result.snapshot
    if (snapshot) {
      if (document.activeElement !== field) field.value = snapshot.url
      status.textContent = `${snapshot.intercept ? "Intercept ON" : "Intercept OFF"} | ${snapshot.pauses.length} held | Service workers bypassed | Profile clears on close`
      error.textContent = snapshot.error ?? ""
    }
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : "Browser operation failed"
  }
}
document.getElementById("navigation")!.addEventListener("submit", (event) => {
  event.preventDefault()
  void invoke("navigate", field.value)
})
document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
  button.addEventListener("click", () => void invoke(button.dataset.action!))
})
const timer = setInterval(async () => {
  if (polling) return
  polling = true
  await invoke("snapshot")
  polling = false
}, 1000)
window.addEventListener("beforeunload", () => clearInterval(timer))
void invoke("snapshot")
