import fs from 'node:fs';
import { LlmpodError, Codes } from './errors.js';

// Set di modelli consigliati (data/model-sets.json): dati verificati a mano sull'API pubblica di Hugging Face.
// Il file è validato al primo caricamento: un errore di schema blocca subito ricerca e piano con un messaggio chiaro.
const FILE = new URL('../../data/model-sets.json', import.meta.url);

// Formati che vLLM v0.30.0 carica nativamente da safetensors di primo livello.
export const MODEL_FORMATS = Object.freeze(['bf16', 'fp8', 'awq', 'gptq', 'compressed-tensors', 'nvfp4', 'mxfp4']);

const SET_ID = /^[a-z0-9][a-z0-9-]*$/;
// Id breve stabile del modello nel set (`<set>/<key>`): non solo cifre, per non confondersi con la posizione `<set>/<n>`.
const MODEL_KEY = /^(?!\d+$)[a-z0-9][a-z0-9.-]*$/;
export const DRAFTS = Object.freeze(['mtp', 'dspark']);
const HF_ID = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isTextOrNull = (v) => v === null || isText(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;

function checkModel(m, where, push) {
  if (!m || typeof m !== 'object') return push(`${where}: deve essere un oggetto`);
  if (!isText(m.id) || !HF_ID.test(m.id)) push(`${where}.id: atteso org/modello di Hugging Face`);
  if (!MODEL_KEY.test(m.key ?? '')) push(`${where}.key: id breve con minuscole, cifre, punti e trattini (non solo cifre)`);
  if (!SHA.test(m.revision ?? '')) push(`${where}.revision: attesa la sha di 40 caratteri della revisione verificata`);
  for (const k of ['family', 'variant', 'notes', 'architecture', 'modelType', 'toolParser']) if (!isText(m[k])) push(`${where}.${k}: testo obbligatorio`);
  if (!MODEL_FORMATS.includes(m.format)) push(`${where}.format: deve essere uno tra ${MODEL_FORMATS.join(', ')}`);
  for (const k of ['quantization', 'reasoningParser', 'license']) if (!isTextOrNull(m[k])) push(`${where}.${k}: testo o null`);
  if (!(typeof m.weightsGiB === 'number' && m.weightsGiB > 0)) push(`${where}.weightsGiB: numero positivo`);
  if (typeof m.mtp !== 'boolean') push(`${where}.mtp: booleano`);
  else if (m.mtp ? !DRAFTS.includes(m.draft) : m.draft !== null) push(`${where}.draft: ${DRAFTS.join(' o ')} se mtp è true, null altrimenti`);
  if (!isPosInt(m.context)) push(`${where}.context: intero positivo`);
  if (!isPosInt(m.recommendedContext) || m.recommendedContext < 1024 || (isPosInt(m.context) && m.recommendedContext > m.context)) {
    push(`${where}.recommendedContext: intero tra 1024 e context`);
  }
  if (m.gated !== undefined && typeof m.gated !== 'boolean' && !isText(m.gated)) push(`${where}.gated: booleano o modalità di accesso`);
}

export function validateModelSets(data) {
  const problems = [];
  const push = (p) => problems.push(p);
  if (!data || typeof data !== 'object') push('il documento deve essere un oggetto');
  else {
    if (!isPosInt(data.version)) push('version: intero positivo');
    if (!isText(data.updatedAt) || !ISO_DATE.test(data.updatedAt)) push('updatedAt: data ISO (AAAA-MM-GG)');
    if (!Array.isArray(data.sets) || data.sets.length === 0) push('sets: almeno un set');
    const setIds = new Set();
    (Array.isArray(data.sets) ? data.sets : []).forEach((s, i) => {
      const where = `sets[${i}]`;
      if (!s || typeof s !== 'object') return push(`${where}: deve essere un oggetto`);
      if (!isText(s.id) || !SET_ID.test(s.id)) push(`${where}.id: minuscole, cifre e trattini`);
      else if (setIds.has(s.id)) push(`${where}.id: set duplicato (${s.id})`);
      else setIds.add(s.id);
      for (const k of ['name', 'description', 'warning']) if (!isText(s[k])) push(`${where}.${k}: testo obbligatorio`);
      if (!Array.isArray(s.models) || s.models.length === 0) return push(`${where}.models: almeno un modello`);
      const ids = new Set();
      const keys = new Set();
      s.models.forEach((m, j) => {
        checkModel(m, `${where}.models[${j}]`, push);
        if (m?.id && ids.has(m.id)) push(`${where}.models[${j}].id: modello duplicato (${m.id})`);
        if (m?.key && keys.has(m.key)) push(`${where}.models[${j}].key: id breve duplicato (${m.key})`);
        ids.add(m?.id);
        keys.add(m?.key);
      });
      return undefined;
    });
  }
  if (problems.length) {
    throw new LlmpodError(Codes.INVALID_INPUT, `data/model-sets.json non valido: ${problems[0]}${problems.length > 1 ? ` (e altri ${problems.length - 1} problemi)` : ''}`, { details: { problems } });
  }
  return data;
}

let cache = null;
function load() {
  cache ??= validateModelSets(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  return cache;
}

export function listSets() {
  const { sets } = load();
  return sets.map(({ models, ...s }) => ({ ...s, count: models.length }));
}

export function getSet(id) {
  const set = load().sets.find((s) => s.id === id);
  if (!set) {
    throw new LlmpodError(Codes.NOT_FOUND, `Set di modelli "${id}" inesistente`, { hint: `Set disponibili: ${load().sets.map((s) => s.id).join(', ')} (elenco: llmpod search --sets)` });
  }
  return set;
}

// Documento completo (per GET /api/model-sets): versione, data di aggiornamento e set con i modelli.
export function modelSetsDocument() {
  return load();
}

// Modelli del set con la posizione (1..n, quella da usare in "llmpod plan <set>/<n>"), filtrati per testo su id, famiglia e variante.
export function filterSetModels(set, query = '') {
  const q = String(query ?? '').trim().toLowerCase();
  return set.models
    .map((model, i) => ({ n: i + 1, model }))
    .filter(({ model: m }) => !q || [m.id, m.family, m.variant].some((t) => t.toLowerCase().includes(q)));
}

// "<set>/<n>" (posizione, cambia se il set viene riordinato) o "<set>/<key>" (id breve stabile) → modello del set alla revisione
// verificata e contesto consigliato; null se non è un riferimento a un set (un id Hugging Face come org/modello resta tale:
// vale solo se la prima parte è un set esistente e la seconda una posizione o un id breve del set).
export function resolveSetRef(ref) {
  const m = String(ref ?? '').trim().match(/^([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9.-]*)$/);
  if (!m) return null;
  const set = load().sets.find((s) => s.id === m[1]);
  if (!set) return null;
  if (!/^\d+$/.test(m[2])) {
    const i = set.models.findIndex((x) => x.key === m[2]);
    if (i < 0) return null;
    const model = set.models[i];
    return { setId: set.id, n: i + 1, model, modelRef: `${model.id}@${model.revision}`, recommendedContext: model.recommendedContext, warning: set.warning };
  }
  const n = Number(m[2]);
  if (n < 1 || n > set.models.length) {
    throw new LlmpodError(Codes.INVALID_INPUT, `Il set "${set.id}" ha ${set.models.length} modelli: ${ref} non esiste`, { hint: `Elenco numerato: llmpod search --set ${set.id}` });
  }
  const model = set.models[n - 1];
  return { setId: set.id, n, model, modelRef: `${model.id}@${model.revision}`, recommendedContext: model.recommendedContext, warning: set.warning };
}
