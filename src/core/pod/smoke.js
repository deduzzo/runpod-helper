const PROMPT = 'Che tempo fa adesso a Messina? Usa lo strumento get_weather.';
const DESCRIPTION = 'Restituisce il meteo attuale di una città';
const SCHEMA = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
const TIMEOUT = 90_000; // sotto il limite di 100 s del proxy Runpod

async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

const short = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? '')).slice(0, 300);

export async function smokeTest({ http, baseUrl, apiKey, model }) {
  const headers = { authorization: `Bearer ${apiKey}` };

  const models = await attempt(async () => {
    const r = await http.request('GET', `${baseUrl}/v1/models`, { headers, timeoutMs: 30_000 });
    const ok = r.ok && (r.data?.data ?? []).some((m) => m.id === model);
    return { ok, detail: ok ? '' : `HTTP ${r.status} ${short(r.data)}` };
  });

  const messages = await attempt(async () => {
    const r = await http.request('POST', `${baseUrl}/v1/messages`, {
      headers: { ...headers, 'anthropic-version': '2023-06-01' }, timeoutMs: TIMEOUT,
      json: { model, max_tokens: 512, tools: [{ name: 'get_weather', description: DESCRIPTION, input_schema: SCHEMA }], messages: [{ role: 'user', content: PROMPT }] },
    });
    const use = r.ok ? (r.data?.content ?? []).find((b) => b.type === 'tool_use') : null;
    const ok = use?.name === 'get_weather';
    return { ok, detail: ok ? '' : `HTTP ${r.status}: nessuna chiamata a get_weather (${short(r.data)})` };
  });

  const chat = await attempt(async () => {
    const r = await http.request('POST', `${baseUrl}/v1/chat/completions`, {
      headers, timeoutMs: TIMEOUT,
      json: { model, max_tokens: 512, tool_choice: 'auto', tools: [{ type: 'function', function: { name: 'get_weather', description: DESCRIPTION, parameters: SCHEMA } }], messages: [{ role: 'user', content: PROMPT }] },
    });
    const call = r.ok ? r.data?.choices?.[0]?.message?.tool_calls?.[0] : null;
    const ok = call?.function?.name === 'get_weather';
    return { ok, detail: ok ? '' : `HTTP ${r.status}: nessuna chiamata a get_weather (${short(r.data)})` };
  });

  return { ok: models.ok && messages.ok && chat.ok, models, messages, chat };
}
