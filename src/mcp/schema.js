import { LlmpodError, Codes } from '../core/errors.js';

// Validatore essenziale del sottoinsieme di JSON Schema usato dagli strumenti MCP di llmpod:
// type (anche elenco), properties, required, additionalProperties: false, items, enum, const,
// minimum/maximum, minLength/maxLength, maxItems, pattern.
const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
};
const matchesType = (v, t) => typeOf(v) === t || (t === 'number' && typeOf(v) === 'integer');

function check(schema, value, where, problems) {
  if (schema.const !== undefined && value !== schema.const) return problems.push(`${where}: deve valere ${JSON.stringify(schema.const)}`);
  if (schema.type) {
    const types = [schema.type].flat();
    if (!types.some((t) => matchesType(value, t))) return problems.push(`${where}: atteso ${types.join(' o ')}`);
  }
  if (schema.enum && !schema.enum.includes(value)) return problems.push(`${where}: valori ammessi ${schema.enum.join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${where}: minimo ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${where}: massimo ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${where}: almeno ${schema.minLength} caratteri`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${where}: al massimo ${schema.maxLength} caratteri`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) problems.push(`${where}: formato non valido`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${where}: al massimo ${schema.maxItems} elementi`);
    if (schema.items) value.forEach((v, i) => check(schema.items, v, `${where}[${i}]`, problems));
  }
  if (typeOf(value) === 'object') {
    for (const k of schema.required ?? []) if (value[k] === undefined) problems.push(`${where}.${k}: obbligatorio`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) check(schema.properties[k], v, `${where}.${k}`, problems);
      else if (schema.additionalProperties === false) problems.push(`${where}.${k}: campo non previsto`);
    }
  }
  return undefined;
}

export function validateInput(schema, value) {
  const problems = [];
  check(schema, value, 'input', problems);
  if (problems.length) throw new LlmpodError(Codes.INVALID_INPUT, `Parametri non validi: ${problems.join('; ')}`);
  return value;
}
