import { describe, it, expect } from 'vitest';
import { shellQuote, shellQuoteArgs } from '../../src/core/planner/shell-quote.js';

describe('shellQuoteArgs', () => {
  it('lascia invariati gli argomenti sicuri', () => {
    expect(shellQuoteArgs(['--max-model-len', '65536', 'Qwen/Qwen3-30B@abc', '--x=a,b+c-d_e.f:g'])).toBe('--max-model-len 65536 Qwen/Qwen3-30B@abc --x=a,b+c-d_e.f:g');
  });
  it('neutralizza sostituzioni di comando e variabili', () => {
    expect(shellQuoteArgs(['$(rm -rf /)'])).toBe("'$(rm -rf /)'");
    expect(shellQuoteArgs(['`id`', '$HOME', 'a;b', 'a&b', 'a|b', 'a>b'])).toBe("'`id`' '$HOME' 'a;b' 'a&b' 'a|b' 'a>b'");
  });
  it('gestisce spazi, newline e stringa vuota', () => {
    expect(shellQuoteArgs(['a b', 'x\ny', ''])).toBe("'a b' 'x\ny' ''");
  });
  it("converte gli apici singoli con '\\''", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
  it('quota il JSON del consulente', () => {
    const json = '{"a":"$(cmd)","b":"it\'s"}';
    expect(shellQuoteArgs(['--default-chat-template-kwargs', json])).toBe(`--default-chat-template-kwargs '{"a":"$(cmd)","b":"it'\\''s"}'`);
  });
});
