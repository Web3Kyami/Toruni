/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUILDER_CODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
