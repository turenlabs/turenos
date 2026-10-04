import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import { iconsSpritesheet } from "vite-plugin-icons-spritesheet"

// The plugin regenerates on every SVG change, without batching. With `formatter: "prettier"` each
// regeneration also starts one process per generated file, so a burst of icon changes (a branch
// switch, `generate:provider-icons`) started hundreds at once. Without a formatter it regenerates
// in-process; the outputs are listed in .prettierignore instead.
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
