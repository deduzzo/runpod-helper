import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlmpodError, Codes } from './errors.js';
import { registerSecret } from './secrets.js';

export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SECRET_VAR = /KEY|TOKEN|SECRET/;
const DEFAULT_CONFIG = {
  cloud: 'SECURE',
  vllmImage: 'vllm/vllm-openai:v0.30.0-cu129',
  minCudaVersion: '12.9',
  volumePricePerGbMonth: 0.07,
  watchdog: { idleMinutes: 30, maxHours: 8 },
};

export function configDir(env = process.env) {
  return env.LLMPOD_CONFIG_DIR || path.join(os.homedir(), '.config', 'llmpod');
}

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

export function serializeEnv(obj) {
  return Object.entries(obj)
    .map(([k, v]) => (/[\s"#=]/.test(v) ? `${k}="${String(v).replace(/"/g, '\\"')}"` : `${k}=${v}`))
    .join('\n') + '\n';
}

export function assertProfileName(name) {
  if (!PROFILE_NAME.test(name ?? '')) {
    throw new LlmpodError(Codes.INVALID_INPUT, `Nome profilo non valido: "${name}"`, {
      hint: 'Usa lettere minuscole, numeri e trattini (max 41 caratteri), es. qwen3-coder-30b',
    });
  }
}

export const profileKeyVar = (name) => `LLMPOD_KEY_${name.toUpperCase().replace(/-/g, '_')}`;

function writeAtomic(file, content, { chmod = true } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  if (chmod) fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// Su Windows (anche dentro il container Docker, dove LLMPOD_HOST_OS=windows) i file montati appaiono 0777 e chmod non ha effetto:
// la protezione di .env è affidata ai permessi NTFS del profilo utente.
export function createStore({ dir = configDir(), platform = process.platform, env = process.env } = {}) {
  const p = (...parts) => path.join(dir, ...parts);
  const posixPerms = platform !== 'win32' && env.LLMPOD_HOST_OS !== 'windows';

  function ensureDir() {
    fs.mkdirSync(p('profiles'), { recursive: true, mode: 0o700 });
    if (posixPerms) fs.chmodSync(dir, 0o700);
  }

  function checkPermissions() {
    if (!posixPerms || !fs.existsSync(p('.env'))) return;
    const m = fs.statSync(p('.env')).mode & 0o777;
    if (m & 0o077) {
      throw new LlmpodError(Codes.CONFIG_PERMISSIONS, `Il file ${p('.env')} è leggibile da altri utenti (permessi ${m.toString(8)})`, {
        hint: `Esegui: chmod 600 "${p('.env')}"`,
      });
    }
  }

  function readEnv() {
    if (!fs.existsSync(p('.env'))) return {};
    const env = parseEnv(fs.readFileSync(p('.env'), 'utf8'));
    for (const [k, v] of Object.entries(env)) if (SECRET_VAR.test(k)) registerSecret(v);
    return env;
  }

  function writeEnv(patch) {
    ensureDir();
    const next = { ...readEnv(), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    writeAtomic(p('.env'), serializeEnv(next), { chmod: posixPerms });
    readEnv();
  }

  function readJson(name, fallback) {
    const f = p(name);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback;
  }

  function writeJson(name, data) {
    ensureDir();
    writeAtomic(p(name), JSON.stringify(data, null, 2) + '\n', { chmod: posixPerms });
  }

  const readConfig = () => {
    const c = readJson('config.json', {});
    return { ...DEFAULT_CONFIG, ...c, watchdog: { ...DEFAULT_CONFIG.watchdog, ...c.watchdog } };
  };
  const writeConfig = (patch) => writeJson('config.json', { ...readJson('config.json', {}), ...patch });

  function readProfile(name) {
    assertProfileName(name);
    const prof = readJson(path.join('profiles', `${name}.json`), null);
    if (!prof) throw new LlmpodError(Codes.NOT_FOUND, `Profilo "${name}" non trovato`, { hint: 'Elenca i profili con: llmpod status' });
    return prof;
  }

  function writeProfile(profile) {
    assertProfileName(profile.name);
    writeJson(path.join('profiles', `${profile.name}.json`), profile);
  }

  const listProfiles = () => (fs.existsSync(p('profiles'))
    ? fs.readdirSync(p('profiles')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()
    : []);

  return {
    dir, ensureDir, checkPermissions, readEnv, writeEnv, readJson, writeJson, readConfig, writeConfig,
    readProfile, writeProfile, listProfiles,
    readState: () => readJson('state.json', { pods: {} }),
    writeState: (s) => writeJson('state.json', s),
  };
}
