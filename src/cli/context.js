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

export function createContext({ env = process.env, io, overrides = {}, platform = process.platform, stdin = process.stdin }) {
  const store = createStore({ dir: configDir(env), platform, env });
  store.checkPermissions();
  const http = overrides.http ?? createHttp({ userAgent: `llmpod/${VERSION}` });
  const events = createEvents();
  const cache = {};
  const ctx = {
    env, io, store, http, events, platform, stdin, overrides,
    cwd: overrides.cwd ?? (() => process.cwd()),
    spawn: overrides.spawn ?? spawn,
    exit: overrides.exit ?? ((code) => process.exit(code)),
    sleep: overrides.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
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
      return (cache.ops ??= ctx.makeOps({ ask: io.ask, askChoice: io.interactive ? io.askChoice : null, events }));
    },
    makeOps({ ask, askChoice = null, events: ev, sleep = overrides.sleep }) {
      return createOps({ store, runpod: ctx.runpod, hf: ctx.hf, http, events: ev, ask, askChoice, sleep, zcode: { dir: zcodeDir(env), isRunning: ctx.isZcodeRunning }, advisor: ctx.advisor });
    },
    get advisor() {
      return {
        config: (endpoint) => resolveAdvisorConfig(store.readEnv(), { endpoint }),
        // Regola unica di attivazione (plan e up): non disattivato con "advisor --disable" E preset configurato nel .env.
        active: () => store.readConfig().advisor?.enabled !== false && Boolean(store.readEnv().LLMPOD_ADVISOR_PRESET),
        // force: ignora "advisor --disable" (es. plan --advisor); richiede comunque una configurazione valida.
        provider(endpoint, { force = false } = {}) {
          if (!force && store.readConfig().advisor?.enabled === false) return null;
          const cfg = resolveAdvisorConfig(store.readEnv(), { endpoint });
          if (!cfg || (cfg.podOnly && !endpoint)) return null;
          const p = createProvider(cfg, { http, spawn: ctx.spawn, env });
          p.podOnly = Boolean(cfg.podOnly);
          return p;
        },
      };
    },
  };
  return ctx;
}
