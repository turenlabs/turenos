const { app, BrowserWindow } = require("electron")
const assert = require("node:assert/strict")

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    })
    const requests = []
    window.webContents.session.webRequest.onBeforeRequest((details, done) => {
      if (/^https?:/.test(details.url)) requests.push(details.url)
      done({ cancel: /^https?:/.test(details.url) })
    })
    await window.loadURL("data:text/html,<html><body><h1>Chat Host</h1></body></html>")
    const html = Buffer.from(process.env.ANIMATION_DOCUMENT, "base64").toString()
    const token = process.env.ANIMATION_TOKEN
    await window.webContents.executeJavaScript(`{
    window.motionMessages = [];
    window.addEventListener('message', event => {
      if (event.source === document.querySelector('iframe')?.contentWindow) window.motionMessages.push(event.data);
    });
    const frame = document.createElement('iframe');
    frame.title = 'Inline animation';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'width:100%;height:480px';
    frame.srcdoc = ${JSON.stringify(html)};
    document.body.append(frame);
  }`)
    const wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration))
    await wait(500)
    const frame = window.webContents.mainFrame.frames[0]
    assert.ok(frame, "Inline animation frame must render")
    const evaluate = (expression) => frame.executeJavaScript(expression)
    const command = async (action, value, channel = token) => {
      await window.webContents.executeJavaScript(
        `document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify({ token: channel, action, value })}, '*')`,
      )
      await wait(60)
    }
    const position = () => evaluate("Number(document.getElementById('ball').getAttribute('cx'))")
    assert.equal(await position(), 10, "Animation starts paused")
    assert.equal(
      await evaluate("document.getAnimations().length"),
      0,
      "Native CSS motion cannot bypass typed timelines",
    )
    assert.equal(
      await evaluate("document.querySelector('animate,animateMotion,animateTransform,set') === null"),
      true,
      "SMIL cannot bypass typed timelines",
    )
    assert.equal(await window.webContents.executeJavaScript("window.motionMessages[0]?.type"), "ready")
    assert.equal(
      await window.webContents.executeJavaScript("window.motionMessages.length"),
      1,
      "Paused frames do not send a periodic clock",
    )
    assert.equal(
      await evaluate("document.querySelectorAll('script').length"),
      2,
      "Only owned JSON and runtime scripts remain",
    )
    assert.equal(await evaluate("document.querySelector('[onload],[onerror],[href],[src]') === null"), true)
    assert.equal(await evaluate("typeof window.api === 'undefined' && typeof require === 'undefined'"), true)
    assert.equal(await evaluate("(() => { try { return !!parent.document.body } catch { return false } })()"), false)
    assert.equal(await window.webContents.executeJavaScript("document.body.dataset.compromised"), undefined)
    await command("seek", 500, "f".repeat(32))
    await evaluate(`window.postMessage({ token: ${JSON.stringify(token)}, action: 'seek', value: 500 }, '*')`)
    await wait(80)
    assert.equal(await position(), 10, "Wrong token and wrong source cannot control the scene")
    await command("seek", 500)
    assert.ok(Math.abs((await position()) - 50) < 0.1, "Scrubbing uses linear time")
    assert.ok(
      Math.abs(Number(await evaluate("document.getElementById('counter').textContent")) - 500) < 1,
      "Numeric labels follow the timeline",
    )
    assert.equal(
      Number(await evaluate("document.getElementById('tiny-counter').textContent")),
      0.000002,
      "Small scientific values retain their scale",
    )
    assert.ok(
      await evaluate("document.getElementById('block').style.transform.includes('40px')"),
      "Transforms follow the timeline",
    )
    const fill = await evaluate("getComputedStyle(document.getElementById('ball')).fill")
    assert.match(fill, /^rgb\(\d+, \d+, \d+\)$/, "Color tracks interpolate")
    assert.notEqual(fill, "rgb(0, 0, 0)")
    assert.notEqual(fill, "rgb(255, 255, 255)")
    await command("seek", 100000)
    assert.ok(Math.abs((await position()) - 50) < 0.1, "Out-of-range messages are ignored")
    await command("restart")
    assert.equal(await position(), 10)
    await command("play")
    await wait(200)
    await command("pause")
    const paused = await position()
    assert.ok(paused > 15 && paused < 90, "Playback advances the scene")
    await wait(200)
    assert.equal(await position(), paused, "Pause stops the scene")
    const count = await window.webContents.executeJavaScript("window.motionMessages.length")
    await wait(220)
    assert.equal(
      await window.webContents.executeJavaScript("window.motionMessages.length"),
      count,
      "Paused reporting stops",
    )
    await command("restart")
    await command("speed", 2)
    await command("play")
    await wait(750)
    assert.equal(await position(), 90, "Finite animation completes at the last keyframe")
    assert.equal(await window.webContents.executeJavaScript("window.motionMessages.at(-1).paused"), true)
    await command("seek", 500)
    await command("stop")
    const stopped = await position()
    await command("play")
    await wait(200)
    assert.equal(await position(), stopped, "Disposed runtime ignores later commands")
    await evaluate("document.querySelector('a').click()")
    await wait(100)
    assert.deepEqual(requests, [], "External resources are blocked before network admission")
    console.log(
      "PASS: inline Anime playback, pause, scrub, speed, labels, colors, finite completion, cleanup, opaque isolation, no injection, no external requests",
    )
    window.destroy()
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
