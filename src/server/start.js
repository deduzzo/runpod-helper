import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { LlmpodError, Codes } from '../core/errors.js';
import { registerSecret } from '../core/secrets.js';
import { isZcodeRunning } from '../core/clients/zcode.js';
import { createInterruptHandler } from '../cli/commands/up.js';
import { createApp } from './app.js';
import { setFrameSources } from './http-utils.js';
import { resolveOpenwebuiUrl, frameSources } from '../core/openwebui-url.js';
import { createRoutes } from './routes.js';
import { createJobs } from './jobs.js';
import { createSse } from './sse.js';
import { createOpenwebuiProxy, createTargetResolver } from './openwebui-proxy.js';

const MIN_KEY_LENGTH = 16;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/;

// Token dell'interfaccia: il valore non compare mai nel messaggio.
export function assertUiToken(token, { source = 'Il token dell\'interfaccia' } = {}) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    throw new LlmpodError(Codes.INVALID_INPUT, `${source} non è valido: servono almeno 16 caratteri tra lettere, cifre, "_" e "-"`, { hint: 'Imposta un token più lungo oppure rimuovi LLMPOD_UI_TOKEN per generarne uno casuale a ogni avvio' });
  }
}

const listen = (server, port, host, what) => new Promise((resolve, reject) => {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      reject(new LlmpodError(Codes.INVALID_INPUT, `La porta ${port} (${what}) è già in uso`, { hint: 'Scegli un\'altra porta con --port / --proxy-port oppure chiudi l\'altro processo' }));
    } else {
      reject(err);
    }
  });
  server.listen(port, host, () => resolve(server.address().port));
});

const closeServer = (server) => new Promise((resolve) => {
  if (!server.listening) { resolve(); return; }
  server.close(() => resolve());
  server.closeAllConnections?.();
});

export async function startUi(ctx, { host = '127.0.0.1', port = 7860, proxyHost = '127.0.0.1', proxyPort = 8081, token, staticDir, proxy = true, version = '0.0.0' }) {
  // Tutti i segreti vanno registrati prima di avviare job o rispondere: readEnv registra le variabili KEY/TOKEN/SECRET
  // (Runpod, HF, consulente, chiavi dei profili, chiave interna di Open WebUI); il token dell'interfaccia non sta nel .env.
  assertUiToken(token);
  registerSecret(token);
  let key = ctx.store.readEnv().LLMPOD_OPENWEBUI_KEY;
  if (!key) {
    key = randomBytes(32).toString('hex');
    ctx.store.writeEnv({ LLMPOD_OPENWEBUI_KEY: key });
  }
  registerSecret(key);
  if (proxy && key.length < MIN_KEY_LENGTH) {
    throw new LlmpodError(Codes.INVALID_INPUT, `LLMPOD_OPENWEBUI_KEY è troppo corta (minimo ${MIN_KEY_LENGTH} caratteri)`, { hint: 'Rimuovi la riga dal file .env per farla rigenerare, oppure impostane una più lunga' });
  }
  // Come il ctx della CLI: il controllo "ZCode in esecuzione" usato da /api/clients/zcode.
  ctx.isZcodeRunning ??= () => isZcodeRunning({ platform: ctx.platform });

  // R27: la CSP deve permettere l'iframe di Open WebUI all'indirizzo configurato (valore non valido → errore chiaro).
  setFrameSources(frameSources(resolveOpenwebuiUrl(ctx.env)));

  const sse = createSse();
  // Una voce per ogni chiamata a ops.up: Pod creato, fase di creazione e ritorno di ops.up. Serve a chiudere "ui"
  // senza lasciare Pod in creazione; lo stato è vivo (aggiornato dagli eventi), mai uno snapshot.
  const ups = [];
  const serverCtx = Object.create(ctx);
  serverCtx.makeOps = (args) => {
    const ops = ctx.makeOps(args);
    if (typeof ops?.up !== 'function') return ops;
    const up = ops.up.bind(ops);
    return Object.assign(Object.create(ops), {
      up(name, ...rest) {
        const rec = { profile: name, podId: null, creating: false, returned: false };
        ups.push(rec);
        const off = args.events?.on?.((e) => {
          if (e.type === 'pod') rec.podId = e.podId;
          if (e.type === 'phase' && /^Creazione del Pod/.test(e.message ?? '')) rec.creating = true;
        });
        return Promise.resolve(up(name, ...rest)).finally(() => { rec.returned = true; off?.(); });
      },
    });
  };
  const jobs = createJobs({ onEvent: (e) => sse.broadcast('job', e) });
  const state = { lastAdvice: null, proxy: null };

  const uiServer = http.createServer();
  const servers = [uiServer];
  const closeAll = async () => {
    sse.close();
    await Promise.all(servers.map(closeServer));
  };

  let actualPort;
  let actualProxyPort = null;
  try {
    actualPort = await listen(uiServer, port, host, 'interfaccia');
    uiServer.on('request', createApp({ ctx: serverCtx, token, port: actualPort, staticDir, jobs, version, routes: createRoutes({ ctx: serverCtx, jobs, sse, state }) }));
    if (proxy) {
      const resolver = createTargetResolver({ store: ctx.store, getOps: () => ctx.ops });
      const proxyServer = http.createServer(createOpenwebuiProxy({ resolveTarget: resolver, internalKey: key, userAgent: `llmpod/${version}` }));
      servers.push(proxyServer);
      actualProxyPort = await listen(proxyServer, proxyPort, proxyHost, 'proxy Open WebUI');
      // Mai la chiave: solo porta e stato.
      state.proxy = { port: actualProxyPort, listening: true };
    }
  } catch (err) {
    await closeAll();
    throw err;
  }

  const trackedUps = () => ups.map((u) => ({ ...u }));

  // R5: come Ctrl+C durante "llmpod up": i Pod la cui ops.up non è ancora tornata (in creazione/attesa) vengono terminati
  // (risposta "sì" automatica, un server non ha un terminale da interrogare); i Pod pronti restano e li spegne il watchdog.
  async function shutdown({ io } = {}) {
    for (const rec of ups) {
      if (!rec.returned) {
        await createInterruptHandler({
          ops: ctx.ops,
          runpod: { listPods: () => ctx.runpod.listPods() },
          io: { ask: async (q) => { io?.err(`${String(q).trim()} Sì (automatico: l'interfaccia si sta chiudendo)`); return true; }, err: (t) => io?.err(t) },
          name: rec.profile,
          getPodId: () => rec.podId,
          isCreating: () => rec.creating,
          exit: () => {},
        })();
        if (!rec.podId && !rec.creating) io?.err(`ℹ Avvio di ${rec.profile} interrotto prima della creazione del Pod: nessun costo`);
      } else if (rec.podId) {
        io?.err(`ℹ Il Pod ${rec.podId} (${rec.profile}) resta attivo: lo spegne il watchdog dopo l'inattività, oppure esegui "llmpod down ${rec.profile}"`);
      }
    }
    for (const j of jobs.list()) {
      if (j.kind.startsWith('down:') && j.status === 'running') io?.err(`⚠ Spegnimento di ${j.kind.slice(5)} ancora in corso: controlla con "llmpod status"`);
    }
    await closeAll();
  }

  return {
    url: `http://127.0.0.1:${actualPort}/?t=${token}`,
    port: actualPort,
    proxyPort: actualProxyPort,
    trackedUps,
    shutdown,
    close: closeAll,
  };
}
