import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function trimSlash(value) {
  return String(value).replace(/\/+$/, '');
}

export const ROOT_DIR = path.resolve(here, '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

export function resolveConfig(overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir || process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
  const storePath = path.resolve(
    overrides.storePath || process.env.STORE_PATH || path.join(dataDir, 'store.json')
  );

  return {
    port: Number(overrides.port || process.env.PORT || 3000),
    dataDir,
    storePath,
    publicDir: overrides.publicDir || PUBLIC_DIR,
    appSecret: overrides.appSecret ?? process.env.APP_SECRET ?? '',
    deepseekBaseUrl: trimSlash(
      overrides.deepseekBaseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
    ),
    shareBaseUrl: trimSlash(
      overrides.shareBaseUrl ||
        process.env.DEEPSEEK_SHARE_BASE_URL ||
        'https://chat.deepseek.com'
    ),
    publicBaseUrl: trimSlash(process.env.PUBLIC_BASE_URL || ''),
    model: 'deepseek-flash',
    requestTimeoutMs: Number(overrides.requestTimeoutMs || 180_000),
    maxZipBytes: Number(overrides.maxZipBytes || 80 * 1024 * 1024)
  };
}
