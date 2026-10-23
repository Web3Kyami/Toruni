/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUILDER_CODE?: string;
  readonly VITE_BUILDER_FEE_BPS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
