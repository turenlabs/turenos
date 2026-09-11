import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("securityBrowser", {
  invoke: (input: { type: string; url?: string }) => ipcRenderer.invoke("security-proxy-toolbar", input),
})
