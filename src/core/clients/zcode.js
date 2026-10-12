import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LlmpodError, Codes } from '../errors.js';
import { updateJsonFile } from './json-file.js';
import { maxOutputTokens, clientContext } from './claude-code.js';

const execFileP = promisify(execFile);

export const zcodeDir = (env = process.env) => env.ZCODE_DIR || path.join(os.homedir(), '.zcode', 'v2');

export function mergeZcodeConfig(cfg, { baseUrl, apiKey, servedName, context }) {
  const out = structuredClone(cfg ?? {});
  out.provider = out.provider ?? {};
  out.provider.llmpod = {
    name: 'llmpod (Runpod)',
    kind: 'openai-compatible',
    source: 'custom',
    options: { apiKey, baseURL: `${baseUrl}/v1`, apiKeyRequired: true },
    models: { [servedName]: { limit: { context: clientContext(context), output: maxOutputTokens(context) } } },
  };
  return out;
}

export async function isZcodeRunning({ platform = process.platform, exec = execFileP } = {}) {
  if (platform === 'win32') {
    const { stdout } = await exec('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe', '/NH']);
    return /ZCode\.exe/i.test(stdout);
  }
  try {
    await exec('pgrep', ['-x', 'ZCode']);
    return true;
  } catch {
    return false; // pgrep esce con 1 se non trova processi
  }
}

export async function updateZcode(endpoint, { dir = zcodeDir(), isRunning = () => isZcodeRunning() } = {}) {
  if (await isRunning()) {
    throw new LlmpodError(Codes.ZCODE_RUNNING, 'ZCode è aperto: le modifiche alla configurazione andrebbero perse', { hint: 'Chiudi ZCode e riprova' });
  }
  const file = path.join(dir, 'config.json');
  updateJsonFile(file, (c) => mergeZcodeConfig(c, endpoint), { invalidCode: Codes.ZCODE_CONFIG_INVALID, label: 'ZCode' });
  return file;
}
