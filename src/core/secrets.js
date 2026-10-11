const MASK = '<REDATTO>';
const SENSITIVE_KEY = /key|token|secret|password|authorization/i;
const values = new Set();

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) values.add(value);
}

export function clearSecrets() {
  values.clear();
}

export function redact(input) {
  if (input === undefined || input === null) return String(input);
  let text = typeof input === 'string' ? input : JSON.stringify(input);
  // I segreti più lunghi prima, così un segreto contenuto in un altro non lascia residui.
  for (const v of [...values].sort((a, b) => b.length - a.length)) {
    text = text.split(v).join(MASK);
  }
  return text;
}

export function redactObject(obj) {
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [
      k,
      SENSITIVE_KEY.test(k) && typeof v === 'string' ? MASK : redactObject(v),
    ]));
  }
  return typeof obj === 'string' ? redact(obj) : obj;
}
