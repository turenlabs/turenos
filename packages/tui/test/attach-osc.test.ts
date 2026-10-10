import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { Api } from "../src/api"
import { attachTerminal, DETACH } from "../src/attach"
import { cleanup, until } from "./support"

const BEL = "\x07"
const ST = "\x1b\\"

/** A socket the test drives by hand: it records the address and delivers whatever frames it is given. */
function attached() {
  const sockets: { url: string; deliver: (data: string) => void; close: (code: number) => void }[] = []
  const stdin = new EventEmitter()
  const stdout = Object.assign(new EventEmitter(), {
    text: "",
    write(chunk: string) {
      stdout.text += chunk
      return true
    },
  })
  const api = (async () => ({ data: { ticket: "t" } })) as unknown as Api
  void attachTerminal({
    url: new URL("http://127.0.0.1:1"),
    api,
    resize: async () => undefined,
    target: { id: "pty_1", title: "shell", directory: "/srv" },
    stdin,
    stdout,
    socket: (url) => {
      const fake = { binaryType: "", readyState: WebSocket.OPEN, send() {}, close() {} } as Record<string, unknown>
      sockets.push({
        url,
        deliver: (data) => (fake.onmessage as (event: unknown) => void)({ data }),
        close: (code) => (fake.onclose as (event: unknown) => void)({ code }),
      })
      return fake as unknown as WebSocket
    },
  })
  cleanup.push(() => stdin.emit("data", Buffer.from([DETACH])))
  return { sockets, stdout }
}

async function shown(frames: string[]) {
  const { sockets, stdout } = attached()
  await until(() => sockets.length === 1)
  frames.forEach((frame) => sockets[0]!.deliver(frame))
  return stdout.text
}

const kept = [
  ["hyperlink, ST", ["\x1b]8;;http://x" + ST + "link\x1b]8;;" + ST]],
  ["working directory, BEL", ["\x1b]7;file:///srv" + BEL]],
  ["hyperlink split in the introducer", ["\x1b", "]", "8;;u" + BEL + "t"]],
  ["a command that only starts like a blocked one", ["\x1b]22;x" + BEL, "\x1b]520;x" + BEL]],
  ["colours split after the escape", ["red\x1b", "[31mx\x1b[0m"]],
  ["escapes in a row", ["\x1b\x1b[1m"]],
  ["an 8-bit hyperlink", ["\u009d8;;u\u009clink"]],
] as const

test.each(kept)("OSC filter leaves %s unchanged", async (_name, frames) => {
  expect(await shown([...frames])).toBe(frames.join(""))
})

const dropped = [
  ["the clipboard, BEL", ["a\x1b]52;c;QUJD" + BEL + "b"]],
  ["a title, ST", ["a\x1b]0;title" + ST + "b"]],
  ["an icon name", ["a\x1b]1;name" + BEL + "b"]],
  ["a window title", ["a\x1b]2;title" + BEL + "b"]],
  ["a sequence split between every message", ["a\x1b", "]", "2;ti", "tle\x1b", "\\b"]],
  ["a command number split in two", ["a\x1b]5", "2;x" + BEL + "b"]],
  ["a sequence ended by a lone BEL message", ["a\x1b]52;c;", "QUJD", BEL, "b"]],
  ["a clipboard payload far longer than one message", ["a\x1b]52;c;", ..."QUJD".repeat(4096).match(/.{1,1000}/g)!, BEL + "b"]],
  ["the 8-bit introducer and terminator", ["a\u009d2;title\u009cb"]],
  ["a sequence cancelled by CAN", ["a\x1b]0;title\x18b"]],
] as const

test.each(dropped)("OSC filter drops %s and keeps the text around it", async (_name, frames) => {
  expect(await shown([...frames])).toBe("ab")
})

test("another escape ends a dropped OSC and is kept, as the host terminal would read it", async () => {
  expect(await shown(["a\x1b]2;title\x1b[31mred"])).toBe("a\x1b[31mred")
  expect(await shown(["a\x1b]2;title\x1b", "[31mred"])).toBe("a\x1b[31mred")
})

test("the reconnect cursor counts what the server sent, not what the filter wrote", async () => {
  const { sockets, stdout } = attached()
  await until(() => sockets.length === 1)
  const frames = ["a\x1b]52;c;QUJD" + BEL, "\x1b]0;t" + ST + "b"]
  frames.forEach((frame) => sockets[0]!.deliver(frame))
  expect(stdout.text).toBe("ab")
  sockets[0]!.close(1011)
  await until(() => sockets.length === 2)
  expect(new URL(sockets[1]!.url).searchParams.get("cursor")).toBe(String(frames.join("").length))
})
