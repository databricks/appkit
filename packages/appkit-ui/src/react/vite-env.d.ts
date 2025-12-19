interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  readonly hot?: {
    on(event: string, handler: (data: any) => void): void;
    off?(event: string, handler: (data: any) => void): void;
  };
}

