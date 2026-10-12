import { LlmpodError, Codes } from './errors.js';
import { httpError } from './http.js';

const HF = 'https://huggingface.co';
const ID = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
const EXPAND = ['downloads', 'lastModified', 'gated', 'safetensors', 'config', 'cardData', 'library_name', 'tags', 'pipeline_tag', 'sha'];

export function parseModelRef(input) {
  let s = String(input ?? '').trim();
  let revision = 'main';
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/([^/\s]+\/[^/\s]+)(?:\/(?:tree|blob|resolve)\/([^/\s]+).*)?\/?$/);
  if (url) {
    s = url[1];
    if (url[2]) revision = url[2];
  } else if (/^[a-z]+:\/\//i.test(s)) {
    s = '';
  } else if (s.includes('@')) {
    [s, revision] = s.split('@');
  }
  if (!ID.test(s) || !revision) {
    throw new LlmpodError(Codes.INVALID_INPUT, `Riferimento al modello non valido: "${input}"`, {
      hint: 'Usa org/modello, org/modello@revisione o l\'URL della pagina Hugging Face',
    });
  }
  return { id: s, revision };
}

// Modello base dichiarato nella model card (stringa o elenco); null se assente.
function baseModelOf(m) {
  const b = m.cardData?.base_model;
  const first = Array.isArray(b) ? b[0] : b;
  return typeof first === 'string' && first ? first : null;
}

export function summarizeModel(m) {
  const tags = m.tags ?? [];
  // Repository GGUF (llama.cpp): senza metadati safetensors vLLM non può caricarlo.
  const isGguf = m.library_name === 'gguf' || tags.includes('gguf');
  const licenseTag = tags.find((t) => t.startsWith('license:'));
  const tok = m.config?.tokenizer_config;
  return {
    id: m.id,
    downloads: m.downloads ?? null,
    lastModified: m.lastModified ?? null,
    gated: m.gated ?? false,
    license: m.cardData?.license ?? (licenseTag ? licenseTag.slice(8) : null),
    params: m.safetensors?.total ?? null,
    paramsByDtype: m.safetensors?.parameters ?? null,
    dtypes: Object.keys(m.safetensors?.parameters ?? {}),
    libraryName: m.library_name ?? null,
    // Formato MLX (Apple Silicon): vLLM non lo carica.
    isMlx: m.library_name === 'mlx' || tags.includes('mlx'),
    isGguf,
    ggufOnly: isGguf && !m.safetensors,
    baseModel: baseModelOf(m),
    // MTP (decodifica speculativa): dai soli metadati disponibili (tag o nome); null = non determinabile senza scaricare i pesi.
    mtp: tags.includes('mtp') || /(^|[^a-z0-9])mtp([^a-z0-9]|$)/i.test(m.id ?? '') ? true : null,
    quantBits: Number.isFinite(m.config?.quantization_config?.bits) ? m.config.quantization_config.bits : null,
    architectures: m.config?.architectures ?? [],
    modelType: m.config?.model_type ?? null,
    hasChatTemplate: Boolean(tok?.chat_template || m.config?.chat_template_jinja),
  };
}

const enc = (id) => id.split('/').map(encodeURIComponent).join('/');
const nextLink = (headers) => headers?.get?.('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;

export function createHf({ http, token } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const get = (url, opts = {}) => http.request('GET', url, { headers, ...opts });

  async function api(url, what, opts) {
    const r = await get(url, opts);
    if (!r.ok) throw httpError(r, what);
    return r;
  }

  async function resolveFile(id, sha, file, what) {
    const r = await get(`${HF}/${enc(id)}/resolve/${encodeURIComponent(sha)}/${file}`, { timeoutMs: 60000 });
    if (r.ok) return r.data;
    if (r.status === 404) return null;
    if (r.status === 401 || r.status === 403) {
      const gatedHint = `Richiedi l'accesso su https://huggingface.co/${id} e imposta HF_TOKEN con "llmpod init"`;
      if (r.status === 403 || (!token && r.headers?.get?.('x-error-code') === 'GatedRepo')) {
        throw new LlmpodError(Codes.GATED_MODEL, `Accesso negato a ${id}`, { hint: gatedHint });
      }
      if (token) {
        throw new LlmpodError(Codes.HF_AUTH, `${what}: token Hugging Face non valido o scaduto`, {
          hint: 'Crea un token "Read" su https://huggingface.co/settings/tokens e aggiornalo con "llmpod init"',
        });
      }
      throw new LlmpodError(Codes.HF_AUTH, `${what}: serve un token Hugging Face per ${id}`, { hint: gatedHint });
    }
    throw httpError(r, what);
  }

  return {
    async searchModels(query, { limit = 20 } = {}) {
      const r = await api(`${HF}/api/models`, 'Ricerca Hugging Face', {
        query: { search: query, filter: 'text-generation', sort: 'downloads', direction: -1, limit, 'expand[]': EXPAND },
      });
      return r.data.map(summarizeModel);
    },
    async getModel(id) {
      return (await api(`${HF}/api/models/${enc(id)}`, `Modello ${id}`, { query: { 'expand[]': EXPAND } })).data;
    },
    async resolveSha(id, revision) {
      return (await api(`${HF}/api/models/${enc(id)}/revision/${encodeURIComponent(revision)}`, `Revisione ${revision}`)).data.sha;
    },
    async listFiles(id, sha) {
      const files = [];
      let url = `${HF}/api/models/${enc(id)}/tree/${encodeURIComponent(sha)}?recursive=true`;
      while (url) {
        const r = await api(url, `File di ${id}`);
        files.push(...r.data);
        url = nextLink(r.headers);
      }
      return files;
    },
    // weight_map di model.safetensors.index.json (file piccolo); null se manca o non è leggibile: il piano ripiega sull'albero dei file.
    async getWeightIndex(id, sha) {
      try {
        const idx = await resolveFile(id, sha, 'model.safetensors.index.json', `Indice dei pesi di ${id}`);
        const map = idx?.weight_map;
        return map && typeof map === 'object' && !Array.isArray(map) ? map : null;
      } catch {
        return null;
      }
    },
    async getConfig(id, sha) {
      const cfg = await resolveFile(id, sha, 'config.json', `Config di ${id}`);
      if (!cfg) throw new LlmpodError(Codes.NOT_FOUND, `config.json non trovato per ${id}@${sha}`);
      return cfg;
    },
    async getReadme(id, sha) {
      const t = await resolveFile(id, sha, 'README.md', `README di ${id}`);
      return typeof t === 'string' ? t : t ? JSON.stringify(t) : null;
    },
    async checkAccess(id, sha) {
      const r = await http.request('HEAD', `${HF}/${enc(id)}/resolve/${encodeURIComponent(sha)}/config.json`, { headers });
      return { ok: r.ok, status: r.status };
    },
  };
}
