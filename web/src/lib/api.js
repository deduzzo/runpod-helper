export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Errore HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
    this.hint = body?.error?.hint;
  }
}

// R26: il server accetta i metodi diversi da GET solo con Content-Type application/json, anche senza corpo ({}).
export async function api(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET' && method !== 'HEAD') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  } else if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: { message: text } }; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const fmtUSD = (n) => (n == null ? '—' : `${Number(n).toFixed(2).replace('.', ',')} $`);
export const fmtGiB = (n) => (n == null ? '—' : `${Number(n).toFixed(1).replace('.', ',')} GiB`);
export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min ${s % 60} s`;
}
