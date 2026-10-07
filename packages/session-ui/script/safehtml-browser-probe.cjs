const { app, BrowserWindow } = require("electron")
const assert = require("node:assert/strict")

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const requests = []
    window.webContents.session.webRequest.onBeforeRequest((details, done) => {
      if (/^https?:/.test(details.url)) requests.push(details.url)
      done({ cancel: /^https?:/.test(details.url) })
    })
    await window.loadURL("data:text/html,<html><body><h1>Chat Host</h1></body></html>")
    await window.webContents.executeJavaScript(`{
    const frame = document.createElement('iframe');
    frame.title = 'Inline visualization';
    frame.setAttribute('sandbox', '');
    frame.style.cssText = 'width:100%;height:480px';
    frame.srcdoc = ${JSON.stringify(Buffer.from(process.env.SAFE_HTML_DOCUMENT, "base64").toString())};
    document.body.append(frame);
  }`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const frame = window.webContents.mainFrame.frames[0]
    assert.ok(frame, "Inline frame must render")
    await assert.rejects(frame.executeJavaScript("1 + 1"), /Script not run/)
    window.webContents.debugger.attach("1.3")
    const targets = await window.webContents.debugger.sendCommand("Target.getTargets")
    const target = targets.targetInfos.find((item) => item.type === "iframe" && item.url === "about:srcdoc")
    const attached = target
      ? await window.webContents.debugger.sendCommand("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: true,
        })
      : undefined
    const command = (name, args) => window.webContents.debugger.sendCommand(name, args, attached?.sessionId)
    const tree = await command("Page.getFrameTree")
    const world = await command("Page.createIsolatedWorld", {
      frameId: attached ? tree.frameTree.frame.id : tree.frameTree.childFrames[0].frame.id,
      worldName: "safehtml-probe",
      grantUniveralAccess: false,
    })
    // DevTools can inspect a no-script frame without granting scripts to its document.
    const evaluate = async (expression) => {
      const result = await command("Runtime.evaluate", {
        expression,
        contextId: world.executionContextId,
        returnByValue: true,
      })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
      return result.result.value
    }
    assert.equal(await evaluate("document.querySelector('h1').textContent"), "Inline Source Map")
    assert.equal(await evaluate("document.querySelector('svg').getBoundingClientRect().width > 0"), true)
    assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), "rgb(238, 247, 255)")
    await evaluate("document.querySelector('summary').click();document.querySelector('input').click()")
    assert.equal(
      await evaluate("document.querySelector('details').open && document.querySelector('input').checked"),
      true,
    )
    assert.equal(
      await evaluate(
        "document.querySelector('script') === null && document.querySelector('[onclick],[onerror],[href],[src]') === null",
      ),
      true,
    )
    assert.equal(await evaluate("typeof window.api === 'undefined' && typeof require === 'undefined'"), true)
    assert.equal(await evaluate("(() => { try { return !!parent.document.body } catch { return false } })()"), false)
    assert.equal(await window.webContents.executeJavaScript("document.body.dataset.compromised"), undefined)
    await evaluate("document.querySelector('a').click()")
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.deepEqual(requests, [], "External CSS and image requests must be blocked before network admission")
    console.log(
      "PASS: inline HTML/CSS/SVG, native controls, opaque sandbox, no bridge, no host access, no external requests",
    )
    window.destroy()
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
