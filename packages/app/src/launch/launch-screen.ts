import * as THREE from "three"
import { logoCloud } from "./logo-cloud"

/**
 * Ember Forge — the TurenOS launch mark.
 *
 * 9,000 sparks converge onto the particle cloud baked from turen-mark.png -
 * the engraved anvil, hardy hole, and waterfall skirt. Particles fly in amber
 * and cool to their baked artwork colors.
 *
 * startForgeScene renders the mark into any host element and runs forever
 * until disposed (used inline as the animated logo). mountLaunchScreen wraps
 * it in the boot overlay: it mounts before the Solid tree renders and is
 * dismissed once the app has mounted and the forge sequence has completed
 * (instantly under prefers-reduced-motion).
 */

const BOOT_MS = 4600
const FADE_MS = 600
const HARD_CAP_MS = 12_000

export interface LaunchScreen {
  /** Call once the app tree has mounted; dismissal waits for the sequence. */
  release: () => void
}

export interface ForgeScene {
  /** True once the particle formation has fully landed. */
  readonly settled: boolean
  /** Fires once when the formation completes. */
  onSettled?: () => void
  dispose: () => void
}

export interface ForgeSceneOptions {
  host: HTMLElement
  canvas: HTMLCanvasElement
  /** Called each frame with the eased formation progress, 0..1. */
  onShown?: (shown: number) => void
  /**
   * True (default) renders for a dark backdrop: additive blending, dark fog.
   * False uses normal blending so the baked artwork reads like the source
   * mark on light surfaces.
   */
  dark?: boolean
  /** Skip the forge-in animation and hold the settled mark. */
  static?: boolean
  layout?: {
    markX: number
    markY: number
    scale: number
    lookX: number
    lookY: number
  }
}

export function startForgeScene(options: ForgeSceneOptions): ForgeScene {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const instant = reduced || (options.static ?? false)
  const dark = options.dark ?? true
  const blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending
  const layout = options.layout ?? { markX: -1.6, markY: 0.25, scale: 1.65, lookX: -0.55, lookY: 0.2 }
  const host = options.host

  const renderer = new THREE.WebGLRenderer({ canvas: options.canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  const scene = new THREE.Scene()
  scene.fog = new THREE.FogExp2(dark ? 0x05070b : 0xf3f4f6, 0.045)
  const camera = new THREE.PerspectiveCamera(42, 16 / 10, 0.1, 60)
  camera.position.set(0, 1.5, 6.6)

  const cloud = decodeCloud()
  const N = cloud.n
  const target = cloud.pos
  for (let i = 0; i < N; i++) {
    target[i * 3] *= layout.scale
    target[i * 3 + 1] *= layout.scale
    target[i * 3 + 2] *= layout.scale
  }
  const scatter = new Float32Array(N * 3)
  const delay = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const th = Math.random() * Math.PI * 2
    const rr = 2.6 + Math.random() * 4.5
    scatter[i * 3] = Math.cos(th) * rr
    scatter[i * 3 + 1] = -2.6 + Math.random() * 5.4
    scatter[i * 3 + 2] = Math.sin(th) * rr * 0.7 - 1.0
    delay[i] = Math.pow(Math.random(), 1.6) * 0.55
  }

  const tex = discTexture()
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.BufferAttribute(target.slice(), 3))
  geo.setAttribute("aScatter", new THREE.BufferAttribute(scatter, 3))
  geo.setAttribute("aTarget", new THREE.BufferAttribute(target, 3))
  geo.setAttribute("aDelay", new THREE.BufferAttribute(delay, 1))
  geo.setAttribute("aColor", new THREE.BufferAttribute(cloud.col, 3))
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uProgress: { value: instant ? 1 : 0 },
      uSize: { value: 9.0 },
      uTex: { value: tex },
      uAmber: { value: new THREE.Color(0xe7af36) },
    },
    vertexShader: [
      "attribute vec3 aScatter;",
      "attribute vec3 aTarget;",
      "attribute float aDelay;",
      "attribute vec3 aColor;",
      "uniform float uTime; uniform float uProgress; uniform float uSize;",
      "uniform vec3 uAmber;",
      "varying vec3 vColor; varying float vAlpha;",
      "void main(){",
      "  float p = smoothstep(aDelay, aDelay + 0.42, uProgress);",
      "  p = p * p * (3.0 - 2.0 * p);",
      "  vec3 pos = mix(aScatter, aTarget, p);",
      "  float wob = (1.0 - p);",
      "  pos.x += sin(uTime * 2.1 + aDelay * 43.0) * 0.10 * wob;",
      "  pos.y += sin(uTime * 3.3 + aDelay * 31.0) * 0.10 * wob;",
      "  pos.z += cos(uTime * 2.6 + aDelay * 27.0) * 0.10 * wob;",
      "  pos += vec3(0.0, sin(uTime * 1.4 + aDelay * 60.0) * 0.006 * p, 0.0);",
      "  vColor = mix(uAmber, aColor, p);",
      "  vAlpha = 0.15 + 0.85 * p;",
      "  vec4 mv = modelViewMatrix * vec4(pos, 1.0);",
      "  gl_PointSize = uSize * (0.7 + 0.9 * (1.0 - p)) * (3.4 / -mv.z);",
      "  gl_Position = projectionMatrix * mv;",
      "}",
    ].join("\n"),
    fragmentShader: [
      "uniform sampler2D uTex;",
      "varying vec3 vColor; varying float vAlpha;",
      "void main(){",
      "  vec4 t = texture2D(uTex, gl_PointCoord);",
      "  gl_FragColor = vec4(vColor, t.a * vAlpha);",
      "}",
    ].join("\n"),
    transparent: true,
    depthWrite: false,
    blending,
  })
  const mark = new THREE.Group()
  mark.add(new THREE.Points(geo, mat))
  mark.position.set(layout.markX, layout.markY, 0)
  mark.rotation.y = 0.08
  scene.add(mark)

  // continuous ember field drifting up from below the mark
  const E = 800
  const eGeo = new THREE.BufferGeometry()
  const seed = new Float32Array(E)
  const ePos = new Float32Array(E * 3)
  for (let k = 0; k < E; k++) {
    seed[k] = Math.random()
    const ea = Math.random() * Math.PI * 2
    const er = Math.random() * 3.0
    ePos[k * 3] = layout.markX + Math.cos(ea) * er
    ePos[k * 3 + 1] = -2.4
    ePos[k * 3 + 2] = Math.sin(ea) * er * 0.6 - 0.8
  }
  eGeo.setAttribute("position", new THREE.BufferAttribute(ePos, 3))
  eGeo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1))
  const eMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uTex: { value: tex }, uAmber: { value: new THREE.Color(0xe7af36) } },
    vertexShader: [
      "attribute float aSeed;",
      "uniform float uTime;",
      "varying float vA;",
      "void main(){",
      "  vec3 p = position;",
      "  float cycle = 5.5 + aSeed * 4.0;",
      "  float h = mod(aSeed * 97.0 + uTime * (0.55 + aSeed * 0.5), cycle) / cycle;",
      "  p.y = -2.4 + h * 5.2;",
      "  p.x += sin(uTime * 0.8 + aSeed * 40.0) * (0.15 + h * 0.45);",
      "  p.z += cos(uTime * 0.6 + aSeed * 31.0) * 0.2;",
      "  vA = (1.0 - h) * (0.25 + aSeed * 0.5);",
      "  vec4 mv = modelViewMatrix * vec4(p, 1.0);",
      "  gl_PointSize = (2.0 + aSeed * 5.0) * (3.4 / -mv.z);",
      "  gl_Position = projectionMatrix * mv;",
      "}",
    ].join("\n"),
    fragmentShader: [
      "uniform sampler2D uTex; uniform vec3 uAmber;",
      "varying float vA;",
      "void main(){",
      "  vec4 t = texture2D(uTex, gl_PointCoord);",
      "  gl_FragColor = vec4(uAmber, t.a * vA);",
      "}",
    ].join("\n"),
    transparent: true,
    depthWrite: false,
    blending,
  })
  scene.add(new THREE.Points(eGeo, eMat))

  const mouse = { x: 0, y: 0 }
  const onPointer = (e: PointerEvent) => {
    mouse.x = (e.clientX / window.innerWidth - 0.5) * 2
    mouse.y = (e.clientY / window.innerHeight - 0.5) * 2
  }
  const onResize = () => {
    const w = host.clientWidth || 1
    const h = host.clientHeight || 1
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
  }
  window.addEventListener("pointermove", onPointer, { passive: true })
  window.addEventListener("resize", onResize)
  onResize()

  const started = performance.now()
  let settled = false
  let raf = 0

  const forge: ForgeScene = {
    get settled() {
      return settled
    },
    dispose: () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("pointermove", onPointer)
      window.removeEventListener("resize", onResize)
      geo.dispose()
      eGeo.dispose()
      mat.dispose()
      eMat.dispose()
      tex.dispose()
      renderer.dispose()
    },
  }

  const tick = (now: number) => {
    const t = now / 1000
    const p = instant ? 1 : Math.min(1, (now - started) / BOOT_MS)
    const eased = p < 0.75 ? p * 0.9 : 0.675 + (p - 0.75) * 1.3
    const shown = Math.min(1, eased)
    mat.uniforms.uTime.value = t
    mat.uniforms.uProgress.value = Math.min(1, shown * 1.12)
    eMat.uniforms.uTime.value = t
    options.onShown?.(shown)
    const sway = Math.sin(t * 0.12) * 0.2 + mouse.x * 0.15
    camera.position.x = Math.sin(sway * 0.12) * 6.6
    camera.position.z = Math.cos(sway * 0.12) * 6.6
    camera.position.y = 1.5 - mouse.y * 0.25
    camera.lookAt(layout.lookX, layout.lookY, 0)
    renderer.render(scene, camera)
    if (!settled && p >= 1) {
      settled = true
      forge.onSettled?.()
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return forge
}

export function mountLaunchScreen(): LaunchScreen {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const host = document.createElement("div")
  host.dataset.component = "launch-screen"
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;background:#05070b;display:flex;align-items:center;justify-content:center"
  const canvas = document.createElement("canvas")
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%"
  const wordmark = document.createElement("div")
  wordmark.textContent = "TurenOS"
  wordmark.style.cssText =
    "position:absolute;left:58%;top:47%;transform:translateY(-50%);" +
    "font-size:58px;font-weight:650;letter-spacing:-0.035em;color:#f2f2f2;" +
    "font-family:var(--font-family-sans),Inter,system-ui,sans-serif;" +
    "opacity:0;transition:opacity 1.2s ease;white-space:nowrap"
  host.append(canvas, wordmark)
  document.body.prepend(host)

  let forge: ForgeScene
  try {
    forge = startForgeScene({
      host,
      canvas,
      onShown: (shown) => {
        if (shown > 0.55) wordmark.style.opacity = "1"
      },
    })
  } catch {
    // No WebGL (or renderer init failure): don't block app boot.
    host.remove()
    return { release: () => {} }
  }

  let released = false
  let dismissed = false
  const dismiss = () => {
    if (dismissed) return
    dismissed = true
    forge.dispose()
    host.style.transition = `opacity ${FADE_MS}ms ease`
    host.style.opacity = "0"
    setTimeout(() => host.remove(), FADE_MS + 50)
  }
  forge.onSettled = () => {
    if (released) dismiss()
  }
  setTimeout(dismiss, HARD_CAP_MS)

  return {
    release: () => {
      released = true
      if (reduced) setTimeout(dismiss, 900)
      else if (forge.settled) dismiss()
    },
  }
}

function decodeCloud() {
  const bin = atob(logoCloud)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const view = new DataView(bytes.buffer)
  const n = bytes.length / 7
  const pos = new Float32Array(n * 3)
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const o = i * 7
    pos[i * 3] = view.getInt16(o, true) / 32767
    pos[i * 3 + 1] = view.getInt16(o + 2, true) / 32767
    pos[i * 3 + 2] = (Math.random() - 0.5) * 0.06
    col[i * 3] = bytes[o + 4] / 255
    col[i * 3 + 1] = bytes[o + 5] / 255
    col[i * 3 + 2] = bytes[o + 6] / 255
  }
  return { n, pos, col }
}

function discTexture() {
  const c = document.createElement("canvas")
  c.width = c.height = 64
  const ctx = c.getContext("2d")!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, "rgba(255,255,255,1)")
  g.addColorStop(0.4, "rgba(255,255,255,0.55)")
  g.addColorStop(1, "rgba(255,255,255,0)")
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}
