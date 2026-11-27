interface ImportMetaEnv {
  readonly VITE_KIMMI_KEY?: string;
  readonly VITE_KIMMI_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
