import { LlmpodError, Codes } from '../errors.js';
import { prepareClaude } from './claude-code.js';
import { prepareOpencode } from './opencode.js';
import { preparePi } from './pi.js';

export function prepareClient(client, ep, { configDir, piDir }) {
  if (client === 'claude') return prepareClaude(ep);
  if (client === 'opencode') return prepareOpencode(ep, { dir: configDir });
  if (client === 'pi') return preparePi(ep, { dir: piDir });
  throw new LlmpodError(Codes.INVALID_INPUT, `Client non gestibile da prepare: ${client}`, { hint: client === 'zcode' ? 'Per ZCode usa: llmpod run zcode' : 'Client: claude, opencode, pi' });
}
