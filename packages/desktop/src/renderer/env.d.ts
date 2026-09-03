import type { ElectronAPI } from "../preload/types"

declare module "*.png" {
  const src: string
  export default src
}

declare global {
  interface Window {
    api: ElectronAPI
    __FORGE__?: {
      deepLinks?: string[]
    }
  }
}
