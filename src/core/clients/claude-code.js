export const maxOutputTokens = (context) => Math.min(32000, Math.max(1024, Math.floor(context / 4)));

export function claudeEnv({ baseUrl, apiKey, servedName, context }) {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: servedName,
    ANTHROPIC_DEFAULT_OPUS_MODEL: servedName,
    ANTHROPIC_DEFAULT_SONNET_MODEL: servedName,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: servedName,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens(context)),
    API_TIMEOUT_MS: '600000',
  };
}

export const prepareClaude = (endpoint) => ({ command: 'claude', args: [], env: claudeEnv(endpoint) });
