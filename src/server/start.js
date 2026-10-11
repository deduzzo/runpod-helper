import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { LlmpodError, Codes } from '../core/errors.js';
import { registerSecret } from '../core/secrets.js';
import { isZcodeRunning } from '../core/clients/zcode.js';
import { createInterruptHandler } from '../cli/commands/up.js';
import { createApp } from './app.js';
import { createRoutes } from './routes.js';
import { createJobs } from './jobs.js';
import { createSse } from './sse.js';
import { createOpenwebuiProxy, createTargetResolver } from './openwebui-proxy.js';

const MIN_KEY_LENGTH = 16;

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

  const sse = createSse();
  // Per ogni job: Pod creato e fase di creazione, serve a chiudere "ui" senza lasciare Pod accesi.
  const tracked = new Map();
  const jobs = createJobs({
    onEvent: (e) => {
      const t = tracked.get(e.jobId) ?? tracked.set(e.jobId, { podId: null, creating: false }).get(e.jobId);
      if (e.type === 'pod') t.podId = e.podId;
      if (e.type === 'phase' && /^Creazione del Pod/.test(e.message ?? '')) t.creating = true;
      sse.broadcast('job', e);
    },
  });
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
    uiServer.on('request', createApp({ ctx, token, port: actualPort, staticDir, jobs, version, routes: createRoutes({ ctx, jobs, sse, state }) }));
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

  const trackedJobs = () => jobs.list().map((j) => ({ jobId: j.id, kind: j.kind, status: j.status, ...(tracked.get(j.id) ?? { podId: null, creating: false }) }));

  // R5: come Ctrl+C durante "llmpod up": i Pod in creazione/attesa vengono terminati (risposta "sì" automatica, un
  // server non ha un terminale da interrogare); i Pod già pronti restano e li spegne il watchdog.
  async function shutdown({ io } = {}) {
    for (const j of trackedJobs()) {
      const [action, ...rest] = j.kind.split(':');
      const profile = rest.join(':');
      if (action === 'up' && j.status === 'running') {
        await createInterruptHandler({
          ops: ctx.ops,
          runpod: { listPods: () => ctx.runpod.listPods() },
          io: { ask: async (q) => { io?.err(`${String(q).trim()} Sì (automatico: l'interfaccia si sta chiudendo)`); return true; }, err: (t) => io?.err(t) },
          name: profile,
          getPodId: () => j.podId,
          isCreating: () => j.creating,
          exit: () => {},
        })();
        if (!j.podId && !j.creating) io?.err(`ℹ Avvio di ${profile} interrotto prima della creazione del Pod: nessun costo`);
      } else if (action === 'up' && j.status === 'done' && j.podId) {
        io?.err(`ℹ Il Pod ${j.podId} (${profile}) resta attivo: lo spegne il watchdog dopo l'inattività, oppure esegui "llmpod down ${profile}"`);
      } else if (action === 'down' && j.status === 'running') {
        io?.err(`⚠ Spegnimento di ${profile} ancora in corso: controlla con "llmpod status"`);
      }
    }
    await closeAll();
  }

  return {
    url: `http://127.0.0.1:${actualPort}/?t=${token}`,
    port: actualPort,
    proxyPort: actualProxyPort,
    trackedJobs,
    shutdown,
    close: closeAll,
  };
}
