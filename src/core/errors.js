const CODE_LIST = [
  'NO_GPU_AVAILABLE', 'INSUFFICIENT_BALANCE', 'GATED_MODEL', 'HF_AUTH', 'OOM',
  'UNKNOWN_TOOL_PARSER', 'ZCODE_RUNNING', 'DOCKER_NOT_RUNNING', 'POD_START_TIMEOUT',
  'SMOKE_TEST_FAILED', 'CONFIG_PERMISSIONS',
  'NETWORK', 'HTTP', 'RUNPOD_AUTH', 'RUNPOD_API', 'REQUEST_INVALID', 'INVALID_INPUT',
  'NOT_FOUND', 'VLLM_ERROR', 'ZCODE_CONFIG_INVALID', 'CANCELLED',
];

export const Codes = Object.freeze(Object.fromEntries(CODE_LIST.map((c) => [c, c])));

export class LlmpodError extends Error {
  constructor(code, message, { hint, cause, details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'LlmpodError';
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}
