import os from 'node:os';
import path from 'node:path';
import { Codes } from '../errors.js';
import { updateJsonFile } from './json-file.js';
import { maxOutputTokens } from './claude-code.js';

export const piDir = (env = process.env) => env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');

export function mergePiModels(cfg, { baseUrl, servedName, context, reasoning }) {
  const out = structuredClone(cfg ?? {});
  out.$schema = out.$schema ?? 'https://pi.dev/schemas/models.schema.json';
  out.providers = out.providers ?? {};
  out.providers.llmpod = {
    baseUrl: `${baseUrl}/v1`,
    api: 'openai-completions',
    apiKey: '$LLMPOD_API_KEY',
    models: [{ id: servedName, name: `${servedName} (llmpod)`, contextWindow: context, maxTokens: maxOutputTokens(context), reasoning: Boolean(reasoning) }],
  };
  return out;
}

export function preparePi(endpoint, { dir = piDir() } = {}) {
  updateJsonFile(path.join(dir, 'models.json'), (c) => mergePiModels(c, endpoint), { invalidCode: Codes.INVALID_INPUT, label: 'pi' });
  return { command: 'pi', args: ['--provider', 'llmpod', '--model', endpoint.servedName], env: { LLMPOD_API_KEY: endpoint.apiKey } };
}
