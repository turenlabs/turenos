import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@turenlabs/app/vite"
import * as fs from "node:fs/promises"

const FORGE_SERVER_DIST = "../forge/dist/node"

const channel = (() => {
  const raw = process.env.FORGE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.FORGE_CHANNEL === "latest") return "prod"
  return "dev"
})()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`
const binaryAssetNames = new Set(["goblin", "stng-core", "libpcap", "static-unpack", "monodis"])
const emailSecurityAsset = "email-security"
const emailAuthenticateAsset = "email-authenticate"
const wasmInspectAsset = "wasm-inspect"
const staticAnalysisAsset = "static-analysis"
const protocolInspectAsset = "protocol-inspect"
const debugSymbolsAsset = "debug-symbols"
const binwalkScanAsset = "binwalk-scan"
const forensicAssets = new Set(["wifi-offline", "windows-artifacts", "rebuild-timeline"])

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.FORGE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
        // Keep this identical to electron-vite's Node 20.11+ shim. Its regex insertion can
        // corrupt bundled TypeScript, while a Rollup banner places the shim safely.
        output: {
          banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
        },
      },
      externalizeDeps: { include: [nodePtyPkg], exclude: ["@turenlabs/schema", "@turenlabs/protocol"] },
    },
    plugins: [
      {
        name: "forge:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "forge:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:forge-server") return this.resolve(`${FORGE_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "forge:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(FORGE_SERVER_DIST)) {
            if (l.endsWith(".wasm")) {
              await fs.copyFile(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/${l}`)
              continue
            }
            if (l === "decompiler-worker.js") {
              await fs.copyFile(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/${l}`)
              continue
            }
            if (l === "yara-worker.js") {
              await fs.copyFile(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/${l}`)
              continue
            }
            if (l === "email-security-worker.js") {
              await fs.copyFile(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/${l}`)
              continue
            }
            if (l === "email-authenticate-worker.js") {
              await fs.mkdir("./out/main/chunks/email-authenticate", { recursive: true })
              await fs.copyFile(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/email-authenticate/${l}`)
              continue
            }
            if (l === "wasm-inspect-worker.js") {
              await fs.copyFile(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/${l}`)
              continue
            }
            if (l === "protocol-inspect-worker.js") {
              await fs.mkdir("./out/main/chunks/protocol-inspect", { recursive: true })
              await fs.copyFile(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/protocol-inspect/${l}`)
              continue
            }
            if (l === "debug-symbols-worker.js") {
              await fs.mkdir("./out/main/chunks/debug-symbols", { recursive: true })
              await fs.copyFile(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/debug-symbols/${l}`)
              continue
            }
            if (l === "binwalk-scan-worker.js") {
              await fs.mkdir("./out/main/chunks/binwalk-scan", { recursive: true })
              await fs.copyFile(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/binwalk-scan/${l}`)
              continue
            }
            if (l === "binary-analysis-worker.js") {
              await fs.mkdir("./out/main/chunks/binary-tools", { recursive: true })
              await fs.copyFile(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/binary-tools/${l}`)
              continue
            }
            if (l === "static-analysis-worker.js") {
              await fs.mkdir("./out/main/chunks/static-analysis", { recursive: true })
              await fs.copyFile(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/static-analysis/${l}`)
              continue
            }
            if (l === "forensic-worker.js") {
              await fs.mkdir("./out/main/chunks/forensic-tools", { recursive: true })
              await fs.copyFile(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/forensic-tools/${l}`)
              continue
            }
            if (l === "ghidra-decompiler")
              await fs.cp(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/${l}`, { recursive: true })
            if (l === "yara-x") await fs.cp(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/${l}`, { recursive: true })
            if (l === emailSecurityAsset)
              await fs.cp(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/${l}`, { recursive: true })
            if (l === emailAuthenticateAsset)
              await fs.cp(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/${l}`, { recursive: true })
            if (l === wasmInspectAsset)
              await fs.cp(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/${l}`, { recursive: true })
            if (l === protocolInspectAsset)
              await fs.cp(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/${l}`, { recursive: true })
            if (l === debugSymbolsAsset)
              await fs.cp(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/${l}`, { recursive: true })
            if (l === binwalkScanAsset)
              await fs.cp(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/${l}`, { recursive: true })
            if (binaryAssetNames.has(l)) {
              await fs.mkdir("./out/main/chunks/binary-tools", { recursive: true })
              await fs.cp(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/binary-tools/${l}`, { recursive: true })
            }
            if (l === staticAnalysisAsset)
              await fs.cp(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/${l}`, { recursive: true })
            if (forensicAssets.has(l)) {
              await fs.mkdir("./out/main/chunks/forensic-tools", { recursive: true })
              await fs.cp(`${FORGE_SERVER_DIST}/${l}`, `./out/main/chunks/forensic-tools/${l}`, { recursive: true })
            }
          }
        },
      },
    ],
  },
  preload: {
    // Mirrors `main` so the preload bridge can drop dev-only APIs at build time
    // rather than exposing them and refusing them at runtime.
    define: {
      "import.meta.env.FORGE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts", "security-browser": "src/preload/security-browser.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          securityBrowser: "src/renderer/security-browser.html",
        },
      },
    },
  },
})
