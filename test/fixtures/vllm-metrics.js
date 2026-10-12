// Testo /metrics di vLLM (motore V1) con decodifica speculativa MTP a 2 token.
export function metricsText({ prompt = 1000, gen = 500, running = 1, waiting = 0, kv = 0.25, drafts = 100, draftTokens = 200, accepted = 150, pos = [90, 60], success = 10, abort = 1, http5 = 0, http4 = 2, preempt = 0, legacyKv = false } = {}) {
  return [
    '# HELP vllm:prompt_tokens_total Number of prefill tokens processed.',
    '# TYPE vllm:prompt_tokens_total counter',
    `vllm:prompt_tokens_total{engine="0",model_name="p"} ${prompt}`,
    `vllm:prompt_tokens_created{engine="0",model_name="p"} 1.7e9`,
    `vllm:generation_tokens_total{engine="0",model_name="p"} ${gen}`,
    `vllm:num_requests_running{engine="0",model_name="p"} ${running}`,
    `vllm:num_requests_waiting{engine="0",model_name="p"} ${waiting}`,
    legacyKv ? `vllm:gpu_cache_usage_perc{model_name="p"} ${kv}` : `vllm:kv_cache_usage_perc{engine="0",model_name="p"} ${kv}`,
    `vllm:num_preemptions_total{engine="0",model_name="p"} ${preempt}`,
    `vllm:request_success_total{engine="0",finished_reason="stop",model_name="p"} ${success}`,
    `vllm:request_success_total{engine="0",finished_reason="length",model_name="p"} 2`,
    `vllm:request_success_total{engine="0",finished_reason="abort",model_name="p"} ${abort}`,
    `vllm:spec_decode_num_drafts_total{engine="0",model_name="p"} ${drafts}`,
    `vllm:spec_decode_num_draft_tokens_total{engine="0",model_name="p"} ${draftTokens}`,
    `vllm:spec_decode_num_accepted_tokens_total{engine="0",model_name="p"} ${accepted}`,
    ...pos.map((v, i) => `vllm:spec_decode_num_accepted_tokens_per_pos_total{engine="0",model_name="p",position="${i}"} ${v}`),
    `http_requests_total{handler="/v1/chat/completions",method="POST",status="2xx"} 12`,
    `http_requests_total{handler="/v1/chat/completions",method="POST",status="4xx"} ${http4}`,
    `http_requests_total{handler="/v1/chat/completions",method="POST",status="5xx"} ${http5}`,
    '',
  ].join('\n');
}
