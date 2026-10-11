import { redactObject } from '../core/secrets.js';

export function createSse({ heartbeatMs = 15_000 } = {}) {
  const clients = new Set();
  const timer = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, heartbeatMs);
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
      for (const res of clients) res.write(payload);
    },
    close() {
      clearInterval(timer);
      for (const res of clients) res.end();
      clients.clear();
    },
    size: () => clients.size,
  };
}
