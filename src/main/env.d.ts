/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  readonly VITE_DEPLOY_ENV?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_MCP_BASE_URL?: string;
}
