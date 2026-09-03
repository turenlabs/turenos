import { ipcMain } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import { assertTrustedRendererEvent } from "./windows"

function handle<Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result,
) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedRendererEvent(event)
    return listener(event, ...(args as Args))
  })
}

function on<Args extends unknown[]>(channel: string, listener: (event: IpcMainEvent, ...args: Args) => void) {
  ipcMain.on(channel, (event, ...args) => {
    if (!assertTrustedRendererEvent(event, false)) return
    listener(event, ...(args as Args))
  })
}

export const TrustedIpc = { handle, on }
