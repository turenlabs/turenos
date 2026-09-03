interface ImportMetaEnv {
  readonly FORGE_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:forge-server" {
  export namespace Server {
    export const listen: typeof import("../../../forge/dist/types/src/node").Server.listen
    export type Listener = import("../../../forge/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../forge/dist/types/src/node").Config.get
    export type Info = import("../../../forge/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../forge/dist/types/src/node").bootstrap
}
