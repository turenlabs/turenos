import { app } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import type { SshServersController } from "./servers"
import { requireSshIpcString, requireSshIpcTarget } from "./policy"
import { TrustedIpc } from "../trusted-ipc"

const ipcMain = TrustedIpc

export function registerSshIpcHandlers(controller: SshServersController) {
  const subscriptions = new Map<number, () => void>()
  const unsubscribe = (id: number) => {
    const off = subscriptions.get(id)
    if (!off) return
    off()
    subscriptions.delete(id)
  }

  app.once("will-quit", () => {
    subscriptions.forEach((off) => off())
    subscriptions.clear()
  })

  ipcMain.handle("ssh-servers-subscribe", (event) => {
    const id = event.sender.id
    if (subscriptions.has(id)) return
    subscriptions.set(
      id,
      controller.subscribe((payload) => {
        if (event.sender.isDestroyed()) {
          unsubscribe(id)
          return
        }
        event.sender.send("ssh-servers-event", payload)
      }),
    )
    event.sender.once("destroyed", () => unsubscribe(id))
  })
  ipcMain.handle("ssh-servers-unsubscribe", (event) => unsubscribe(event.sender.id))
  ipcMain.handle("ssh-servers-get-state", () => controller.getState())
  ipcMain.handle("ssh-servers-probe-runtime", () => controller.probeRuntime())
  ipcMain.handle("ssh-servers-probe-host", (_event: IpcMainInvokeEvent, input: unknown) =>
    controller.probeHost(requireSshIpcTarget(input)),
  )
  ipcMain.handle("ssh-servers-install-forge", (_event: IpcMainInvokeEvent, id: string) =>
    controller.installForge(requireSshIpcString("server id", id)),
  )
  ipcMain.handle("ssh-servers-add", (_event: IpcMainInvokeEvent, input: unknown) =>
    controller.addServer(requireSshIpcTarget(input)),
  )
  ipcMain.handle("ssh-servers-remove", (_event: IpcMainInvokeEvent, id: string) =>
    controller.removeServer(requireSshIpcString("server id", id)),
  )
  ipcMain.handle("ssh-servers-start", (_event: IpcMainInvokeEvent, id: string) =>
    controller.startServer(requireSshIpcString("server id", id)),
  )
  ipcMain.handle("ssh-servers-stop-remote", (_event: IpcMainInvokeEvent, id: string) =>
    controller.stopRemote(requireSshIpcString("server id", id)),
  )
  ipcMain.handle("ssh-servers-respond-prompt", (_event: IpcMainInvokeEvent, requestId: string, response: unknown) =>
    controller.respondPrompt(requireSshIpcString("request id", requestId), typeof response === "string" ? response : null),
  )
}
