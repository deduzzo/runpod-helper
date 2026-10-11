import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { LlmpodError, Codes } from '../core/errors.js';
import { createStore, configDir } from '../core/config.js';
import { createHttp } from '../core/http.js';
import { createRunpod } from '../core/runpod.js';
import { createHf } from '../core/hf.js';
import { createEvents } from '../core/events.js';
import { createOps } from '../core/ops.js';
import { resolveAdvisorConfig } from '../core/advisor/presets.js';
import { createProvider } from '../core/advisor/providers.js';
import { zcodeDir, isZcodeRunning } from '../core/clients/zcode.js';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

export function createContext({ env = process.env, io, overrides = {}, platform = process.platform }) {
  const store = createStore({ dir: configDir(env), platform });
  store.checkPermissions();
  const http = overrides.http ?? createHttp({ userAgent: `llmpod/${VERSION}` });
  const events = createEvents();
  const cache = {};
  const ctx = {
    env, io, store, http, events, platform,
    spawn: overrides.spawn ?? spawn,
    isZcodeRunning: overrides.isZcodeRunning ?? (() => isZcodeRunning({ platform })),
    get runpod() {
      if (overrides.runpod) return overrides.runpod;
      const apiKey = store.readEnv().RUNPOD_API_KEY;
      if (!apiKey) throw new LlmpodError(Codes.RUNPOD_AUTH, 'RUNPOD_API_KEY non configurata', { hint: 'Esegui: llmpod init' });
      return (cache.runpod ??= createRunpod({ http, apiKey }));
    },
    get hf() {
      return overrides.hf ?? (cache.hf ??= createHf({ http, token: store.readEnv().HF_TOKEN }));
    },
    get ops() {
      return (cache.ops ??= createOps({ store, runpod: ctx.runpod, hf: ctx.hf, http, events, ask: io.ask, zcode: { dir: zcodeDir(env), isRunning: ctx.isZcodeRunning } }));
    },
    get advisor() {
      return {
        config: (endpoint) => resolveAdvisorConfig(store.readEnv(), { endpoint }),
        provider(endpoint) {
          if (store.readConfig().advisor?.enabled === false) return null;
          const cfg = resolveAdvisorConfig(store.readEnv(), { endpoint });
          if (!cfg || (cfg.podOnly && !endpoint)) return null;
          return createProvider(cfg, { http, spawn: ctx.spawn });
        },
      };
    },
  };
  return ctx;
}
