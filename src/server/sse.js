import { redactObject } from '../core/secrets.js';

const MAX_BUFFERED = 1_048_576;

export function createSse({ heartbeatMs = 15_000 } = {}) {
  const clients = new Set();
  // Backpressure: un client che non legge (buffer oltre 1 MB) viene chiuso e rimosso, senza crescita illimitata della memoria.
  const send = (res, chunk) => {
    if (res.writableLength > MAX_BUFFERED) {
      clients.delete(res);
      res.destroy();
      return;
    }
    res.write(chunk);
  };
  const timer = setInterval(() => { for (const res of [...clients]) send(res, ': ping\n\n'); }, heartbeatMs);
  timer.unref?.();
  return {
    handler(req, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': ok\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },
    broadcast(type, data) {
      const payload = `event: ${type}\ndata: ${JSON.stringify(redactObject(data))}\n\n`;
      for (const res of [...clients]) send(res, payload);
    },
    close() {
      clearInterval(timer);
      for (const res of clients) res.end();
      clients.clear();
    },
    size: () => clients.size,
  };
}
