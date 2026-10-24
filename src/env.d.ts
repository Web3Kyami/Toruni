/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUILDER_CODE?: string;
  readonly VITE_BUILDER_FEE_BPS?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
