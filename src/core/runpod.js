import { LlmpodError, Codes } from './errors.js';
import { httpError } from './http.js';

export const RUNPOD_API = 'https://api.runpod.io/v2';
const GRAPHQL = 'https://api.runpod.io/graphql';

export const proxyUrl = (podId, port) => `https://${podId}-${port}.proxy.runpod.net`;

function runpodError(res, what) {
  const base = httpError(res, what);
  if (res.status === 401 || res.status === 403) {
    return new LlmpodError(Codes.RUNPOD_AUTH, base.message, { hint: 'Verifica RUNPOD_API_KEY e i suoi permessi con "llmpod init"' });
  }
  if (res.status === 402) {
    return new LlmpodError(Codes.INSUFFICIENT_BALANCE, base.message, { hint: 'Ricarica il credito su https://www.runpod.io/console/user/billing' });
  }
  return new LlmpodError(Codes.RUNPOD_API, base.message, { details: { status: res.status } });
}

export function createRunpod({ http, apiKey, base = RUNPOD_API }) {
  const headers = { authorization: `Bearer ${apiKey}` };
  const req = (method, path, opts = {}) => http.request(method, `${base}${path}`, { headers, ...opts });
  async function call(method, path, opts, what) {
    const r = await req(method, path, opts);
    if (!r.ok) throw runpodError(r, what);
    return r.data;
  }

  return {
    listGpus: async ({ count = 1, cloud = 'SECURE', minCudaVersion } = {}) =>
      (await call('GET', '/catalog/gpus', { query: { include: 'AVAILABILITY', product: 'POD', count, cloud, minCudaVersion } }, 'Catalogo GPU')).gpus,

    listDataCenters: async () =>
      (await call('GET', '/catalog/datacenters', { query: { include: 'GPU_AVAILABILITY' } }, 'Datacenter')).dataCenters,

    async listPods() {
      const pods = [];
      let cursor;
      do {
        const d = await call('GET', '/pods', { query: cursor ? { cursor } : {} }, 'Elenco Pod');
        pods.push(...d.pods);
        cursor = d.pagination?.hasNextPage ? d.pagination.nextCursor : null;
      } while (cursor);
      return pods;
    },

    async getPod(id) {
      const r = await req('GET', `/pods/${encodeURIComponent(id)}`);
      if (r.status === 404) return null;
      if (!r.ok) throw runpodError(r, `Pod ${id}`);
      return r.data;
    },

    createPod: async (body) => {
      const r = await req('POST', '/pods', { json: body, timeoutMs: 60000 });
      return { status: r.status, data: r.data };
    },

    async deletePod(id) {
      const r = await req('DELETE', `/pods/${encodeURIComponent(id)}`);
      if (!r.ok && r.status !== 404) throw runpodError(r, `Terminazione Pod ${id}`);
    },

    listVolumes: async () => (await call('GET', '/network-volumes', {}, 'Network volume')).networkVolumes,
    createVolume: ({ name, size, dataCenter }) =>
      call('POST', '/network-volumes', { json: { name, size, dataCenter } }, 'Creazione network volume'),
    async deleteVolume(id) {
      const r = await req('DELETE', `/network-volumes/${encodeURIComponent(id)}`);
      if (!r.ok && r.status !== 404) throw runpodError(r, `Eliminazione volume ${id}`);
    },

    async getBalance() {
      const r = await http.request('POST', GRAPHQL, { headers, json: { query: '{ myself { clientBalance currentSpendPerHr } }' } });
      if (!r.ok || r.data?.errors) throw runpodError(r.ok ? { status: 403, data: { detail: r.data.errors[0]?.message } } : r, 'Credito Runpod');
      const m = r.data.data.myself;
      return { balance: Number(m.clientBalance), spendPerHour: Number(m.currentSpendPerHr ?? 0) };
    },
  };
}
