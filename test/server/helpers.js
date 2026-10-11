import http from 'node:http';

// Richiesta HTTP grezza verso il server di prova. `body` è una stringa già serializzata.
export function request(port, pathname, { method = 'GET', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host: host ?? `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* risposta non JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: text, text, json });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// Client delle API autenticato: cookie di sessione, Origin e (per i metodi che modificano stato) Content-Type JSON sempre presente.
export function apiClient({ port, token }) {
  return (pathname, { method = 'GET', body, headers = {} } = {}) => {
    const mutating = !['GET', 'HEAD'].includes(method);
    return request(port, pathname, {
      method,
      headers: {
        cookie: `llmpod_session=${token}`,
        ...(mutating ? { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: mutating ? JSON.stringify(body ?? {}) : undefined,
    });
  };
}

// Apre il flusso SSE e raccoglie i frammenti ricevuti.
export function openEvents({ port, token, pathname = '/api/events' }) {
  const received = [];
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: pathname, headers: { host: `127.0.0.1:${port}`, cookie: `llmpod_session=${token}` } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => received.push(c));
      resolve({ received, text: () => received.join(''), close: () => r.destroy() });
    });
    r.on('error', () => {});
  });
}
