/// <reference types="vite/client" />

declare module 'libredwg-wasm?url' {
  const url: string;
  export default url;
}

interface ImportMetaEnv {
  /** Version de l'application (package.json), posée par vite.config.ts. */
  readonly VITE_APP_VERSION: string;
}
