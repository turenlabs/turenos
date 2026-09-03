import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/forge-theme-preload.js", import.meta.url))

const channel = (() => {
  const raw = process.env.FORGE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.FORGE_CHANNEL === "latest") return "prod"
  return "dev"
})()

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "forge-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        define: {
          "import.meta.env.VITE_FORGE_CHANNEL": JSON.stringify(channel),
        },
        server: {
          proxy: {
            "/turen-lobby": {
              target: "http://127.0.0.1:8787",
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/turen-lobby/, ""),
            },
          },
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  {
    name: "forge-desktop:theme-preload",
    transformIndexHtml(html) {
      return html.replace(
        '<script id="forge-theme-preload-script" src="/forge-theme-preload.js"></script>',
        `<script id="forge-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
    },
  },
  tailwindcss(),
  solidPlugin(),
]
