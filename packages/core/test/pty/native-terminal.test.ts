import { expect, test } from "bun:test"
import { spawn } from "../../src/pty/pty.bun"

async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Native terminal did not complete within 5 seconds")), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test("native terminal handles input, UTF-8 output, resize, and process exit", async () => {
  const pty = spawn(
    process.execPath,
    [
      "-e",
      'console.log("ready"); process.stdin.on("data", () => { console.log("received:\\u00e9"); process.exit(0) })',
    ],
    { name: "xterm-256color" },
  )
  let output = ""
  let ready: () => void = () => {}
  let received: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    ready = resolve
  })
  const completed = new Promise<void>((resolve) => {
    received = resolve
  })
  const data = pty.onData((value) => {
    output += value
    if (output.includes("ready")) ready()
    if (output.includes("received:\u00e9")) received()
  })
  const exited = new Promise<number>((resolve) => pty.onExit((event) => resolve(event.exitCode)))
  try {
    await bounded(started)
    pty.resize(100, 30)
    pty.write("input\r\n")
    await bounded(completed)
    expect(await bounded(exited)).toBe(0)
  } finally {
    data.dispose()
    pty.kill()
  }
}, 20_000)

test("native terminal kill terminates its child", async () => {
  const pty = spawn(process.execPath, ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'], {
    name: "xterm-256color",
  })
  const ready = new Promise<void>((resolve) =>
    pty.onData((value) => {
      if (value.includes("ready")) resolve()
    }),
  )
  const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()))
  try {
    await bounded(ready)
    pty.kill()
    await bounded(exited)
    expect(() => process.kill(pty.pid, 0)).toThrow()
  } finally {
    pty.kill()
  }
}, 20_000)

test("native terminal releases resources when spawn fails", () => {
  expect(() => spawn("turen-missing-terminal-command", [], { name: "xterm" })).toThrow()
})

test("native terminal drains the final output of a busy child", async () => {
  const pty = spawn(
    process.execPath,
    ["-e", 'process.stdout.write("X".repeat(131072) + "output-complete", () => process.exit(0))'],
    { name: "xterm-256color" },
  )
  let output = ""
  const drained = new Promise<void>((resolve) =>
    pty.onData((value) => {
      output += value
      if (output.includes("output-complete")) resolve()
    }),
  )
  const exited = new Promise<number>((resolve) => pty.onExit((event) => resolve(event.exitCode)))
  try {
    expect(await bounded(exited)).toBe(0)
    await bounded(drained)
    expect(output).toContain("output-complete")
    if (process.platform !== "win32") expect(output.split("X").length - 1).toBe(131072)
  } finally {
    pty.kill()
  }
}, 20_000)
