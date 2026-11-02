const { app, BrowserWindow } = require("electron")
const { spawn } = require("node:child_process")
const { join } = require("node:path")
const { statSync } = require("node:fs")
const [root, bun, idle] = process.argv.slice(2)
const { createSidecarSupervisor } = require(join(root, "supervisor.cjs"))
if ((statSync(root).mode & 0o777) !== 0o700) throw new Error("Scratch root is not private")
app.setPath("userData", join(root, "xdg_data_home"))
app.setPath("sessionData", join(root, "xdg_cache_home"))
app.on("window-all-closed", () => {})
const started = Date.now()
const emit = (row) =>
  console.log(JSON.stringify({ utc: new Date().toISOString(), elapsedMs: Date.now() - started, ...row }))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let child
let window
let spawned = 0
let exits = 0
let queued = 0
const supervisor = createSidecarSupervisor({
  spawn: (onExit) =>
    new Promise((resolve, reject) => {
      spawned++
      child = spawn(bun, [join(__dirname, "process-attribution-bun.ts")], {
        env: process.env,
        stdio: ["pipe", "pipe", "ignore"],
      })
      child.once("error", reject)
      let pending = ""
      child.stdout.on("data", (chunk) => {
        pending += chunk.toString()
        const lines = pending.split("\n")
        pending = lines.pop()
        for (const line of lines.filter(Boolean)) {
          const row = JSON.parse(line)
          emit(row)
          if (row.phase === "allocated")
            resolve({
              listener: {
                stop: async () => {
                  child.stdin.end("stop\n")
                },
              },
            })
        }
      })
      child.once("exit", (code) => {
        exits++
        onExit(code ?? 1)
      })
    }),
  ready: () => {},
  exited: () => {},
  respawning: () => {
    queued++
  },
  exhausted: () => {},
  failed: () => {
    app.exit(1)
  },
})
const deadline = setTimeout(
  () => {
    child?.kill("SIGKILL")
    app.exit(1)
  },
  Number(idle) + 15000,
)
async function run() {
  await app.whenReady()
  emit({
    role: "identity",
    pid: process.pid,
    parentPid: process.ppid,
    electron: process.versions.electron,
    node: process.versions.node,
    profileIsolated: app.getPath("userData") === join(root, "xdg_data_home"),
  })
  const listener = await supervisor.start()
  window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  await window.loadURL("data:text/html,<title>Disposable attribution fixture</title>")
  window.webContents.debugger.attach("1.3")
  await window.webContents.executeJavaScript("window.held = new Uint8Array(4 * 1024 * 1024); window.held.fill(7)")
  const sample = async (phase) => {
    emit({
      role: "electron-main",
      pid: process.pid,
      parentPid: process.ppid,
      phase,
      ...process.memoryUsage(),
      nativeAllocationBytes: null,
    })
    for (const metric of app.getAppMetrics())
      emit({
        role: metric.pid === process.pid ? "electron-main-os" : metric.type === "Tab" ? "renderer" : "electron-child",
        pid: metric.pid,
        creationTime: metric.creationTime,
        phase,
        rss: metric.memory.workingSetSize * 1024,
        heapUsed: null,
        external: null,
        nativeAllocationBytes: null,
      })
    if (!window.isDestroyed()) {
      const heap = await window.webContents.debugger.sendCommand("Runtime.getHeapUsage")
      emit({
        role: "renderer-heap",
        pid: window.webContents.getOSProcessId(),
        phase,
        heapUsed: heap.usedSize,
        heapTotal: heap.totalSize,
        external: null,
        nativeAllocationBytes: null,
      })
    }
  }
  await sample("allocated")
  await window.webContents.executeJavaScript("window.held = null")
  for (let elapsed = 0; elapsed < Number(idle); elapsed += 500) {
    await wait(500)
    await sample("idle")
  }
  window.webContents.debugger.detach()
  window.destroy()
  await listener.listener.stop()
  for (let attempt = 0; attempt < 100 && exits === 0; attempt++) await wait(10)
  supervisor.stop()
  await wait(1200)
  await sample("teardown")
  const passed = spawned === 1 && exits === 1 && queued === 1
  emit({
    role: "lifecycle",
    pid: process.pid,
    spawned,
    exits,
    queued,
    postShutdownSpawns: spawned - 1,
    rendererDestroyed: window.isDestroyed(),
    passed,
  })
  clearTimeout(deadline)
  app.exit(passed ? 0 : 1)
}
run().catch(() => {
  supervisor.stop()
  child?.kill("SIGKILL")
  app.exit(1)
})
