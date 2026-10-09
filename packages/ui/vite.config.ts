import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import { iconsSpritesheet } from "vite-plugin-icons-spritesheet"

// No formatter: with `formatter: "prettier"` the plugin starts one process per generated file on every
// regeneration, and a burst of icon changes (a branch switch, `generate:provider-icons`) started
// hundreds at once. patches/vite-plugin-icons-spritesheet@3.0.1.patch sorts the icon list, since
// directory order differs by OS and runtime, and runs one regeneration at a time per icon set.
export default defineConfig({
  plugins: [
    solidPlugin(),
    iconsSpritesheet([
      {
        withTypes: true,
        inputDir: "src/assets/icons/file-types",
        outputDir: "src/components/file-icons",
      },
      {
        withTypes: true,
        inputDir: "src/assets/icons/provider",
        outputDir: "src/components/provider-icons",
        iconNameTransformer: (iconName) => iconName,
      },
    ]),
  ],
  server: { port: 3001 },
  build: {
    target: "esnext",
  },
  worker: {
    format: "es",
  },
})
