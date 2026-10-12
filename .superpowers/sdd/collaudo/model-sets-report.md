# Collaudo — set di modelli consigliati ("abliterated")

Branch `feat/model-sets` (da origin/main). Data della ricerca: 12 ottobre 2026. Fonti: API pubblica di
Hugging Face senza token (`/api/models`, `/tree`, `config.json`, `model.safetensors.index.json`),
registro dei modelli e liste dei parser di vLLM al tag **v0.30.0** (`vllm/model_executor/models/registry.py`,
`vllm/tool_parsers/__init__.py`, `vllm/reasoning/__init__.py`) e recipe ufficiali
(github.com/vllm-project/recipes, `models/*.yaml`). Nessuna credenziale, nessuna chiamata a Runpod.

## Esito

- `data/model-sets.json`: set `abliterated` con 14 modelli in 8 famiglie, avviso sull'uso responsabile.
- Core `src/core/model-sets.js`: `listSets()`, `getSet(id)`, `filterSetModels()`, `resolveSetRef("<set>/<n>")`,
  validazione dello schema al primo caricamento (`validateModelSets`).
- CLI: `llmpod search --sets`, `llmpod search [testo] --set <id>` (colonne #, Modello, Variante, Formato, Pesi,
  MTP, Contesto, Consigliato), `llmpod plan <set>/<n>` (revisione verificata; contesto consigliato salvo
  `--context`). Senza `--set` la ricerca resta globale; `search` senza testo né set dà un errore con esempi.
- API: `GET /api/model-sets`; `POST /api/plan` accetta anche `<set>/<n>`.
- Web (pagina Modelli): selettore **Ricerca** (tutti / set consigliato), avviso, filtro, schede con
  formato, pesi, MTP, contesto, parser, licenza, note e pulsante **Calcola il piano** (precompila
  `id@revisione` e il contesto consigliato e calcola il piano). Controlli nativi (select, input, button)
  quindi accessibili da tastiera; stile glass/neon con fade-up scaglionato e hover luminoso; verificato a
  390 px e 1280 px con un server locale su configurazione vuota.
- Parser (`data/parsers.json`, con `source` della recipe): `DeepseekV4ForCausalLM` → deepseek_v4 /
  deepseek_v4 + `--tokenizer-mode deepseek_v4`; `DeepseekV41ForCausalLM` → deepseek_v41 / deepseek_v41 +
  `--tokenizer-mode deepseek_v41`; entrambe con l'argomento DSpark della recipe (vedi "Correzioni");
  `Qwen4ExpForConditionalGeneration` (Qwen3.8-Flash-Next) → qwen3_coder / qwen3. Il planner non avvisa più
  "nessun chat template" quando la regola imposta `--tokenizer-mode`.
- README: sezione "Set di modelli consigliati" (uso, criteri, aggiornamento).

## Set finale

| # | Id breve | Modello | Variante | Formato | Pesi | Draft | Contesto max | Consigliato | Parser (tool · reasoning) | Licenza |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | qwen3.8-27b-gptq | llmfan46/Qwen3.8-27B-Uncensored-Heretic-Native-MTP-Preserved-GPTQ-Int4 | GPTQ Int4 | gptq | 18,2 GiB | MTP | 262.144 | 131.072 | qwen3_coder · qwen3 | apache-2.0 |
| 2 | qwen3.8-27b-bf16 | llmfan46/Qwen3.8-27B-Uncensored-Heretic-Native-MTP-Preserved | BF16 | bf16 | 51,7 GiB | MTP | 262.144 | 131.072 | qwen3_coder · qwen3 | apache-2.0 |
| 3 | qwen3.6-35b-a3b-gptq | llmfan46/Qwen3.6-35B-A3B-uncensored-heretic-Native-MTP-Preserved-GPTQ-Int4 | GPTQ Int4 | gptq | 20,8 GiB | MTP | 262.144 | 131.072 | qwen3_coder · qwen3 | apache-2.0 |
| 4 | gpt-oss-120b-mxfp4 | kldzj/gpt-oss-120b-heretic-v2 | MXFP4 | mxfp4 | 60,8 GiB | — | 131.072 | 131.072 | openai · openai_gptoss | apache-2.0 |
| 5 | minimax-m2.7-awq | alonsoko/MiniMax-M2.7-BF16-ultra-uncensored-heretic-AWQ-W4A16 | AWQ W4A16 | compressed-tensors | 111,6 GiB | — | 204.800 | 131.072 | minimax_m2 · minimax_m2 | other |
| 6 | minimax-m2.7-bf16 | llmfan46/MiniMax-M2.7-BF16-ultra-uncensored-heretic | BF16 | bf16 | 426,0 GiB | — | 204.800 | 131.072 | minimax_m2 · minimax_m2 | other |
| 7 | qwen3.8-flash-next-nvfp4 | dealignai/Qwen3.8-Flash-Next-ABLITERATED-NVFP4 | NVFP4 | nvfp4 | 125,9 GiB | MTP | 262.144 | 131.072 | qwen3_coder · qwen3 | other |
| 8 | qwen3.8-flash-next-fp8 | dealignai/Qwen3.8-Flash-Next-UNCENSORED-FP8 | FP8 | fp8 | 172,8 GiB | MTP | 262.144 | 131.072 | qwen3_coder · qwen3 | apache-2.0 |
| 9 | deepseek-v4-flash-0731-fp8 | apetersson/DeepSeek-V4-Flash-0731-Abliterated-FP8 | FP8 (0731) | fp8 | 155,4 GiB | DSpark | 1.048.576 | 131.072 | deepseek_v4 · deepseek_v4 | mit |
| 10 | deepseek-v4.1-flash-fp8 | dealignai/DeepSeek-V4.1-Flash-UNCENSORED-FP8 | FP8 | fp8 | 475,3 GiB | DSpark | 1.048.576 | 131.072 | deepseek_v41 · deepseek_v41 | mit |
| 11 | glm-5.3-flash-nvfp4 | dealignai/GLM-5.3-Flash-UNCENSORED-NVFP4 | NVFP4 | nvfp4 | 181,3 GiB | MTP | 1.048.576 | 131.072 | glm47 · glm47 | mit |
| 12 | glm-5.3-flash-fp8 | dealignai/GLM-5.3-Flash-UNCENSORED-FP8 | FP8 | fp8 | 305,8 GiB | MTP | 1.048.576 | 131.072 | glm47 · glm47 | mit |
| 13 | glm-5.3-nvfp4 | dealignai/GLM-5.3-UNCENSORED-NVFP4 | NVFP4 | nvfp4 | 432,9 GiB | MTP | 1.048.576 | 65.536 | glm47 · glm47 | mit |
| 14 | glm-5.3-fp8 | dealignai/GLM-5.3-UNCENSORED-FP8 | FP8 | fp8 | 703,7 GiB | MTP | 1.048.576 | 65.536 | glm47 · glm47 | mit |

## Candidati valutati

Pesi: somma degli shard safetensors di primo livello (per i modelli del set: solo quelli elencati
nell'indice, come fa il planner). MTP: tensori `mtp.*` o strati nextn oltre `num_hidden_layers` nel
weight_map ("?" = indice non leggibile senza token). Formato da `config.json` `quantization_config`.

| Repository | Revisione | Formato | Pesi GiB | MTP | Architettura / model_type | Contesto | Licenza | Gated | Download/like | Aggiornato | base_model | Esito |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| zai-org/GLM-5.3-Flash | eb9eb208eb0d | FP8 | 305.8 | sì | Glm5NextForConditionalGeneration / glm5_next | 1048576 | mit | false | 6539199/2801 | 2026-09-07 | — | Riferimento (modello base, non abliterated) |
| zai-org/GLM-5.3 | aca966e4e027 | FP8 | 703.7 | sì | GlmMoeDsaForCausalLM / glm_moe_dsa | 1048576 | other | false | 1694033/2179 | 2026-09-04 | — | Riferimento (modello base, non abliterated) |
| orcarouter/GLM-5.3-Flash-Uncensored-FP8 | 150bd5e3a957 | BF16 | 305.8 | ? | ? (gated) | ? | mit | auto | 221508/288 | 2026-10-12 | zai-org/GLM-5.3-Flash | Escluso: gated "auto" (config e weight_map non verificabili senza token; serve accettare le condizioni). Il più popolare: alternativa valida con HF_TOKEN |
| orcarouter/GLM-5.3-Flash-Uncensored-NVFP4 | 0d5b22fd1d31 | BF16 | 191 | ? | ? (gated) | ? | mit | auto | 3434/86 | 2026-10-12 | zai-org/GLM-5.3-Flash | Escluso: gated "auto", non verificabile senza token |
| dealignai/GLM-5.3-Flash-UNCENSORED-FP8 | d5822b068da8 | FP8 | 305.8 | sì | Glm5NextForConditionalGeneration / glm5_next | 1048576 | mit | false | 43877/151 | 2026-09-19 | zai-org/GLM-5.3-Flash | **Nel set (#12)** |
| dealignai/GLM-5.3-Flash-UNCENSORED-NVFP4 | 745aac2ff0f1 | NVFP4 (modelopt) | 181.3 | sì | Glm5NextForConditionalGeneration / glm5_next | 1048576 | mit | false | 7267/49 | 2026-09-19 | zai-org/GLM-5.3-Flash | **Nel set (#11)** |
| hell0ks/GLM-5.3-Flash-Uncensored-AWQ | fbc204e57749 | compressed-tensors pack-quantized | 177.7 | sì | Glm5NextForConditionalGeneration / glm5_next | 1048576 | mit | false | 5889/3 | 2026-08-29 | orcarouter/GLM-5.3-Flash-Uncensored-FP8 | Escluso: valido (AWQ compressed-tensors, MTP) ma pubblicatore poco diffuso (3 like); dimensione simile all'NVFP4 scelto |
| voska/GLM-5.3-Flash-Uncensored-W4A16 | fb58f613c212 | BF16 | 177.7 | ? | ? (gated) | ? | mit | auto | 808/4 | 2026-09-17 | orcarouter/GLM-5.3-Flash-Uncensored-FP8 | Escluso: gated "auto", non verificabile senza token |
| AIAgens/GLM-5.3-Flash-UNCENSORED-W4A16 | eb29cc9cd438 | compressed-tensors pack-quantized | 181.3 | sì | Glm5NextForConditionalGeneration / glm5_next | 1048576 | mit | false | 253/0 | 2026-08-31 | zai-org/GLM-5.3-Flash, JANGQ-AI/GLM-5.3-Flash-W4A16 | Escluso: valido ma 0 like, 253 download |
| audnai/penclaw-GLM-5.3-abliterated | 027ae98a6f9d | BF16 | 1403.2 | ? | ? (gated) | ? | other | manual | 1932/385 | 2026-09-02 | — | Escluso: gated "manual", pesi anche in sottocartelle (iter*), 1.4 TB, nessun config verificabile |
| dealignai/GLM-5.3-ABLITERATED-NVFP4 | 371bdb985d01 | NVFP4 (modelopt) | 432.9 | sì | GlmMoeDsaForCausalLM / glm_moe_dsa | 1048576 | mit | false | 1415/40 | 2026-09-08 | zai-org/GLM-5.3 | Escluso: equivalente all'UNCENSORED-NVFP4 dello stesso autore, meno popolare |
| dealignai/GLM-5.3-UNCENSORED-FP8 | 12170112d07e | FP8 | 703.7 | sì | GlmMoeDsaForCausalLM / glm_moe_dsa | 1048576 | mit | false | 2590/136 | 2026-09-08 | zai-org/GLM-5.3, JANGQ-AI/GLM-5.3-FP8 | **Nel set (#14)** |
| dealignai/GLM-5.3-UNCENSORED-NVFP4 | 409ddf484d16 | NVFP4 (modelopt) | 432.9 | sì | GlmMoeDsaForCausalLM / glm_moe_dsa | 1048576 | mit | false | 1918/67 | 2026-09-08 | zai-org/GLM-5.3 | **Nel set (#13)** |
| redkits/GLM-5.3-ABLITERATED-FP8 | 814f78686803 | FP8 | 703.7 | sì | GlmMoeDsaForCausalLM / glm_moe_dsa | 1048576 | mit | false | 110/1 | 2026-09-15 | zai-org/GLM-5.3, JANGQ-AI/GLM-5.3-FP8 | Escluso: copia poco diffusa (1 like) dell'FP8 di dealignai |
| edp1096/Huihui-GLM-5.3-Flash-abliterated-NVFP4 | 25a335075327 | NVFP4 (modelopt) | 190.4 | sì | Glm5NextForConditionalGeneration / glm5_next | 1048576 | mit | false | 270/2 | 2026-09-27 | nvidia/GLM-5.3-Flash-NVFP4, huihui-ai/GLM-5.3-Flash-abliterated-GGUF | Escluso: base dichiarata GGUF (huihui), provenienza poco chiara, 2 like |
| Blackroot/glm-5.3-flash-abliterated | f40703b48d83 | ? | 0 | ? | ? (gated) | ? | ? | false | 0/1 | 2026-08-28 | — | Escluso: repository vuoto (nessun safetensors né config) |
| disasters/GLM-5.3-Flash-ABLITERATED-Colibri-INT4-gs64 | ac34c6d871cd | FP8 | 181.4 | ? | Glm5NextForConditionalGeneration / glm5_next | 1048576 | mit | false | 381/7 | 2026-09-12 | dealignai/GLM-5.3-Flash-ABLITERATED-FP8 | Escluso: config dichiara fp8 ma pesi INT4 "Colibri" (formato non nativo vLLM); senza indice |
| Asilarkness/GLM-5.3-Flash-Uncensored-NVFP4-Pruning-62GB | 7fcc98b84e80 | compressed-tensors nvfp4-pack-quantized | 61.9 | no | Glm5NextForConditionalGeneration / glm5_next | 1048576 | apache-2.0 | false | 910/12 | 2026-09-03 | orcarouter/GLM-5.3-Flash-Uncensored-NVFP4 | Escluso: esperti potati (qualità ridotta) e niente strato MTP nei pesi |
| deepseek-ai/DeepSeek-V4.1-Flash | 2cba9e42aa02 | FP8 | 475.3 | sì | DeepseekV41ForCausalLM / deepseek_v41 | 1048576 | mit | false | 1382367/4366 | 2026-10-01 | — | Riferimento (modello base) |
| deepseek-ai/DeepSeek-V4-Pro-0813 | 72e1d3230f6c | FP8 | 831.4 | sì | DeepseekV4ForCausalLM / deepseek_v4 | 1048576 | mit | false | 82451/868 | 2026-08-13 | — | Riferimento (base); nessuna variante abliterated safetensors diffusa; 831 GiB |
| dealignai/DeepSeek-V4.1-Flash-UNCENSORED-FP8 | d61c59ea5e51 | FP8 | 475.3 | sì | DeepseekV41ForCausalLM / deepseek_v41 | 1048576 | mit | false | 79933/534 | 2026-09-11 | deepseek-ai/DeepSeek-V4.1-Flash | **Nel set (#10)** |
| MomonV/DeepSeek-V4.1-Flash-UNCENSORED-NVFP4 | 1dec890b0326 | FP8 | 491.1 | sì | DeepseekV41ForCausalLM / deepseek_v41 | 1048576 | mit | false | 545/3 | 2026-09-22 | nvidia/DeepSeek-V4.1-Flash-NVFP4, dealignai/DeepSeek-V4.1-Flash-UNCENSORED-FP8 | Escluso: merge NVFP4 di un pubblicatore poco diffuso (3 like), più grande dell'FP8 (491 GiB) |
| s-zaizen/DeepSeek-V4.1-Flash-Abliterated | 23da584e06e5 | FP8 | 475.3 | sì | DeepseekV41ForCausalLM / deepseek_v41 | 1048576 | mit | false | 1144/11 | 2026-09-10 | deepseek-ai/DeepSeek-V4.1-Flash | Escluso: valido ma meno popolare (11 like) del dealignai |
| distributedcognition/DeepSeek-V4.1-Flash-abliterated | 6ee13e7ac7c9 | BF16 | 475.3 | ? | ? (gated) | ? | mit | auto | 574/16 | 2026-09-11 | deepseek-ai/DeepSeek-V4.1-Flash | Escluso: gated "auto", non verificabile senza token |
| securepeak/DeepSeek-V4.1-Flash-Abliterated | ac12fcceee31 | FP8 | 713.1 | sì | DeepseekV41ForCausalLM / deepseek_v41 | 1048576 | mit | false | 247/4 | 2026-10-03 | deepseek-ai/DeepSeek-V4.1-Flash | Escluso: shard extra fuori indice (713 GiB nell'albero), 4 like |
| apetersson/DeepSeek-V4-Flash-0731-Abliterated-FP8 | 7d02640c72a2 | FP8 | 155.4 | sì | DeepseekV4ForCausalLM / deepseek_v4 | 1048576 | mit | false | 2574/38 | 2026-08-01 | deepseek-ai/DeepSeek-V4-Flash-0731 | **Nel set (#9)** |
| lovesenko/DeepSeek-V4-Flash-0731-Abliterated | 61ec100749f5 | FP8 | 155.4 | sì | DeepseekV4ForCausalLM / deepseek_v4 | 1048576 | mit | false | 14401/9 | 2026-08-03 | deepseek-ai/DeepSeek-V4-Flash-0731 | Escluso: valido ma 9 like; scelto apetersson (base di altre quantizzazioni) |
| cebeuq/DeepSeek-V4-Flash-0731-abliterated | 21bd923c2574 | FP8 | 156.9 | sì | DeepseekV4ForCausalLM / deepseek_v4 | 1048576 | mit | false | 2194/42 | 2026-08-01 | deepseek-ai/DeepSeek-V4-Flash-0731 | Escluso: valido (42 like) ma un file in più rispetto all'originale; scelto apetersson |
| sakamakismile/DeepSeek-V4-Flash-0731-Abliterated-NVFP4 | 4b15c44c31f8 | FP8 | 163.5 | sì | DeepseekV4ForCausalLM / deepseek_v4 | 1048576 | mit | false | 450/15 | 2026-08-02 | deepseek-ai/DeepSeek-V4-Flash-0731, apetersson/DeepSeek-V4-Flash-0731-Abliterated-FP8 | Escluso: più grande dell'FP8 nativo (163,5 GiB): nessun vantaggio |
| squanchyzx/DeepSeek-V4-Flash-0731-HERETIC-Abliterated-FP8 | c2f2796ccc8e | FP8 | 156.5 | sì | DeepseekV4ForCausalLM / deepseek_v4 | 1048576 | mit | false | 663/21 | 2026-08-12 | deepseek-ai/DeepSeek-V4-Flash-0731 | Escluso: valido, meno popolare (21 like) |
| dealignai/DeepSeek-V4-Flash-0731-CRACK-NVFP4 | c66fe3848cb8 | FP8 | 155.4 | sì | DeepseekV4ForCausalLM / deepseek_v4 | 1048576 | mit | false | 438/24 | 2026-08-12 | deepseek-ai/DeepSeek-V4-Flash-0731 | Escluso: nome NVFP4 ma config fp8 identica all'originale; ambiguo |
| orcarouter/DeepSeek-V4-Flash-Vision-Uncensored | 81e3526ab88f | BF16 | 156.3 | ? | ? (gated) | ? | mit | auto | 2112/63 | 2026-10-12 | deepseek-ai/DeepSeek-V4-Flash-Vision-Exp | Escluso: gated "auto", non verificabile senza token |
| drowzeys/DeepSeek-V4-Flash-DSpark-Abliterated-Uncensored | 324310d59474 | BF16 | 155.4 | ? | ? (gated) | ? | mit | auto | 1480/87 | 2026-07-12 | deepseek-ai/DeepSeek-V4-Flash-DSpark | Escluso: gated "auto", non verificabile senza token |
| llmfan46/Qwen3.8-27B-Uncensored-Heretic-Native-MTP-Preserved-GPTQ-Int4 | aedc6ce29b7b | GPTQ 4 bit | 18.2 | sì | Qwen3_5ForConditionalGeneration / qwen3_5 | 262144 | apache-2.0 | false | 4469/3 | 2026-08-31 | llmfan46/Qwen3.8-27B-Ultra-Uncensored-Heretic-Native-MTP-Preserved | **Nel set (#1)** |
| llmfan46/Qwen3.8-27B-Ultra-Uncensored-Heretic-Native-MTP-Preserved | 4b9e1517a43f | BF16 | 51.7 | sì | Qwen3_5ForConditionalGeneration / qwen3_5 | 262144 | apache-2.0 | false | 1194/14 | 2026-08-31 | Qwen/Qwen3.8-27B | Nel set con l'id canonico (questo nome reindirizza a …-Uncensored-Heretic-Native-MTP-Preserved) |
| llmfan46/Qwen3.8-27B-Uncensored-Heretic-Native-MTP-Preserved | 4b9e1517a43f | BF16 | 51.7 | sì | Qwen3_5ForConditionalGeneration / qwen3_5 | 262144 | apache-2.0 | false | 1194/14 | 2026-08-31 | Qwen/Qwen3.8-27B | **Nel set (#2)** |
| llmfan46/Qwen3.8-27B-Uncensored-Heretic-Native-MTP-Preserved-NVFP4 | 98b34bd9ea6a | NVFP4 (modelopt) | 19.2 | sì | Qwen3_5ForConditionalGeneration / qwen3_5 | 262144 | apache-2.0 | false | 4454/1 | 2026-08-31 | llmfan46/Qwen3.8-27B-Ultra-Uncensored-Heretic-Native-MTP-Preserved | Escluso: alternativa valida (19,2 GiB, MTP) ma 1 like; tenute GPTQ (in uso) e BF16 |
| Qwen/Qwen3.8-27B | 1d4bf0f2ff60 | BF16 | 51.7 | sì | Qwen3_5ForConditionalGeneration / qwen3_5 | 262144 | apache-2.0 | false | 6843108/17517 | 2026-08-14 | — | Riferimento (modello base) |
| huihui-ai/Huihui-Qwen3.8-27B-abliterated | 739e3c5b8984 | BF16 | 51.7 | sì | Qwen3_5ForConditionalGeneration / qwen3_5 | 262144 | apache-2.0 | false | 43182/556 | 2026-08-24 | Qwen/Qwen3.8-27B | Escluso: valido e popolare, ma la variante llmfan46 è quella in uso (preferenza utente) |
| twolven/Qwen3.8-27B-abliterated-AWQ-MTP | c2f5341e7c9a | compressed-tensors pack-quantized | 18.2 | sì | Qwen3_5ForConditionalGeneration / qwen3_5 | 262144 | apache-2.0 | false | 43993/18 | 2026-08-21 | JonathanColetti/Qwen3.8-27B-Uncensored | Escluso: valido (AWQ, MTP) ma base di provenienza poco nota |
| sakamakismile/Huihui-Qwen3.8-27B-abliterated-NVFP4 | 36276309d302 | compressed-tensors nvfp4-pack-quantized | 19.1 | sì | Qwen3_5ForConditionalGeneration / qwen3_5 | 262144 | apache-2.0 | false | 23000/65 | 2026-08-24 | huihui-ai/Huihui-Qwen3.8-27B-abliterated | Escluso: valido (NVFP4, MTP, 65 like); doppione funzionale del GPTQ in uso |
| orcarouter/Qwen3.8-27B-Uncensored-FP8 | 8b4ede700a2e | BF16 | 28.7 | ? | ? (gated) | ? | apache-2.0 | auto | 159408/1795 | 2026-10-12 | Qwen/Qwen3.8-27B | Escluso: gated "auto", non verificabile senza token (molto popolare) |
| orcarouter/Qwen3.8-27B-Uncensored-NVFP4 | f8489198f18f | BF16 | 23 | ? | ? (gated) | ? | apache-2.0 | auto | 114218/295 | 2026-10-12 | Qwen/Qwen3.8-27B | Escluso: gated "auto", non verificabile senza token |
| Qwen/Qwen3.8-Flash-Next | de4b8e4d43b9 | BF16 | 335.3 | sì | Qwen4ExpForConditionalGeneration / qwen4_exp | 262144 | other | false | 1870465/6114 | 2026-08-27 | — | Riferimento (modello base) |
| dealignai/Qwen3.8-Flash-Next-ABLITERATED-NVFP4 | be794b990578 | NVFP4 (modelopt) | 125.9 | sì | Qwen4ExpForConditionalGeneration / qwen4_exp | 262144 | other | false | 7775/33 | 2026-08-28 | Qwen/Qwen3.8-Flash-Next | **Nel set (#7)** |
| dealignai/Qwen3.8-Flash-Next-ABLITERATED-FP8 | e6b9e4541bb6 | FP8 | 172.8 | sì | Qwen4ExpForConditionalGeneration / qwen4_exp | 262144 | apache-2.0 | false | 697/13 | 2026-09-05 | Qwen/Qwen3.8-Flash-Next-FP8 | Escluso: equivalente all'UNCENSORED-FP8 dello stesso autore, meno popolare |
| dealignai/Qwen3.8-Flash-Next-UNCENSORED-FP8 | 0df192cfd5b2 | FP8 | 172.8 | sì | Qwen4ExpForConditionalGeneration / qwen4_exp | 262144 | apache-2.0 | false | 922/29 | 2026-09-05 | Qwen/Qwen3.8-Flash-Next-FP8 | **Nel set (#8)** |
| huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated | 298f94632b78 | BF16 | 335.3 | sì | Qwen4ExpForConditionalGeneration / qwen4_exp | 262144 | other | false | 921/50 | 2026-10-01 | Qwen/Qwen3.8-Flash-Next | Escluso: BF16 da 335 GiB; FP8/NVFP4 bastano |
| orcarouter/Qwen3.8-Flash-Next-Uncensored-FP8 | a9208847b981 | BF16 | 172.8 | ? | ? (gated) | ? | apache-2.0 | auto | 24954/47 | 2026-10-12 | Qwen/Qwen3.8-Flash-Next | Escluso: gated "auto", non verificabile senza token |
| llmfan46/Qwen3.6-35B-A3B-uncensored-heretic-Native-MTP-Preserved-GPTQ-Int4 | fb685a8409e4 | GPTQ 4 bit | 20.8 | sì | Qwen3_5MoeForConditionalGeneration / qwen3_5_moe | 262144 | apache-2.0 | false | 19019/11 | 2026-05-09 | llmfan46/Qwen3.6-35B-A3B-uncensored-heretic-Native-MTP-Preserved | **Nel set (#3)** |
| llmfan46/Qwen3.6-35B-A3B-uncensored-heretic-Native-MTP-Preserved | 9599ac17d26d | BF16 | 67 | sì | Qwen3_5MoeForConditionalGeneration / qwen3_5_moe | 262144 | apache-2.0 | false | 749/45 | 2026-05-09 | Qwen/Qwen3.6-35B-A3B | Escluso: BF16 (67 GiB) valido; tenuta solo la GPTQ (più economica) |
| llmfan46/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-GPTQ-Int4 | b0b4429102b5 | GPTQ 4 bit | 18.2 | sì | Qwen3_5ForConditionalGeneration / qwen3_5 | 262144 | apache-2.0 | false | 302/10 | 2026-05-07 | llmfan46/Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved | Escluso: superato da Qwen3.8-27B |
| llmfan46/MiniMax-M2.7-BF16-ultra-uncensored-heretic | 35ead5dab17a | BF16 | 426 | no | MiniMaxM2ForCausalLM / minimax_m2 | 204800 | other | false | 282/13 | 2026-05-20 | amd/MiniMax-M2.7-BF16 | **Nel set (#6)** |
| alonsoko/MiniMax-M2.7-BF16-ultra-uncensored-heretic-AWQ-W4A16 | b3f3ce2e9856 | compressed-tensors pack-quantized | 111.6 | no | MiniMaxM2ForCausalLM / minimax_m2 | 204800 | other | false | 112/2 | 2026-05-17 | llmfan46/MiniMax-M2.7-BF16-ultra-uncensored-heretic | **Nel set (#5)** |
| ressl/MiniMax-M3-uncensored | 315b596663fb | BF16 | 795.5 | no | MiniMaxM3SparseForConditionalGeneration / minimax_m3_vl | 1048576 | other | false | 393/38 | 2026-07-16 | MiniMaxAI/MiniMax-M3 | Escluso: 795 GiB BF16, niente MTP nei pesi (nextn dichiarato ma assente) |
| ressl/MiniMax-M3-uncensored-NVFP4 | 6863c5c62a89 | NVFP4 (modelopt) | 242.4 | no | MiniMaxM3SparseForConditionalGeneration / minimax_m3_vl | 1048576 | other | false | 556/11 | 2026-07-16 | ressl/MiniMax-M3-uncensored | Escluso: valido (minimax_m3, v0.30.0) ma senza MTP nei pesi e poco diffuso (11 like); recipe ancora "nightly" |
| OpenYourMind/Minimax-M3-abliterated-clean | 0c23bb9854ff | BF16 | 795.5 | no | MiniMaxM3SparseForConditionalGeneration / minimax_m3_vl | 1048576 | other | false | 123/11 | 2026-06-16 | MiniMaxAI/MiniMax-M3 | Escluso: 795 GiB BF16, senza MTP |
| llmfan46/MiniMax-M3-uncensored-heretic-balanced | d3b6b3315675 | BF16 | 795.4 | ? | ? (gated) | ? | other | manual | 0/8 | 2026-07-20 | MiniMaxAI/MiniMax-M3 | Escluso: gated "manual", 0 download |
| Uniboshi/Kimi-K3-Abliterated-V1 | e95407d0d389 | BF16 | 1453.7 | ? | ? (gated) | ? | other | auto | 1988/133 | 2026-07-31 | moonshotai/Kimi-K3 | Escluso: gated "auto" e 1454 GiB (oltre 8×H200); config non verificabile |
| kldzj/gpt-oss-120b-heretic-v2 | b14888fdf746 | MXFP4 | 60.8 | no | GptOssForCausalLM / gpt_oss | 131072 | apache-2.0 | false | 519/22 | 2025-11-18 | — | **Nel set (#4)** |
| llmfan46/gpt-oss-120b-ultra-heretic | 255ce583421e | MXFP4 | 60.8 | no | GptOssForCausalLM / gpt_oss | 131072 | apache-2.0 | false | 97/6 | 2026-03-27 | openai/gpt-oss-120b | Escluso: valido (MXFP4) ma 6 like; scelto kldzj v2 |
| wangzhang/gpt-oss-120b-abliterated | 3358d330ba77 | BF16 | 217.6 | no | GptOssForCausalLM / gpt_oss | 131072 | apache-2.0 | false | 284/8 | 2026-08-29 | openai/gpt-oss-120b | Escluso: dequantizzato in BF16 (217,6 GiB) senza vantaggi sull'MXFP4 |
| wangzhang/Devstral-Small-2-24B-Instruct-abliterated | f0b016a6bd1c | BF16 | 44.7 | ? | Mistral3ForConditionalGeneration / mistral3 | 393216 | apache-2.0 | false | 124/6 | 2026-08-29 | mistralai/Devstral-Small-2-24B-Instruct-2512 | Escluso: manca tekken.json (richiesto da --tokenizer-mode mistral della regola), 6 like |

Esclusi a monte per formato (non ispezionati oltre i tag): tutte le varianti GGUF (es. huihui-ai
Huihui-GLM-5.3-Flash-abliterated-GGUF, Huihui-DeepSeek-V4-Flash-0731-abliterated-GGUF,
Huihui-Qwen3.8-27B-abliterated-GGUF, llmfan46 …-GGUF), MLX/JANG (dealignai …-JANG-CRACK, …-MLX-4bit),
EXL3 (Infatoshi GLM-5.3-UNCENSORED-EXL3, MikeRoz …-exl3, dealignai DeepSeek-V4.1-Flash-UNCENSORED-EXL3),
NInfer e "ds4" (formati non vLLM), LoRA/PEFT. Kimi K2.x/K3 e Mistral/Devstral: nessuna variante
abliterated safetensors adatta (vedi tabella). MiMo-V2.6 non considerato: la recipe richiede vLLM 0.31.0.

## Correzioni dopo la revisione

Branch riallineato a origin/main con rebase (nessun conflitto; `syncDerivedFields` di main con `mtp.tokens` e la
nuova `mtpLabel` conservati ed estesi).

1. **DSpark (critico).** DeepSeek-V4-Flash-0731 e V4.1 hanno tensori `mtp.*` che sono stadi DSpark (config con
   `dspark_block_size`, `dspark_target_layer_ids`… ; niente e_proj/h_proj/enorm/hnorm). Nuovo `draftKind(config,
   weightMap)` in `vram.js`: `dspark` se config o text_config hanno chiavi `dspark_*`, altrimenti `mtp`. Il planner usa
   il campo `dspark` della regola (recipe V4-Flash, variante 0731: `{"method":"dspark","num_speculative_tokens":7,
   "draft_sample_method":"probabilistic"}`; recipe V4.1 su NVIDIA: `{"method":"dspark","num_speculative_tokens":5,
   "draft_sample_method":"probabilistic","rejection_sample_method":"block","enable_adaptive_verification":true}`),
   in mancanza `DSPARK_SPEC` (valore 0731). Note del #9 corrette ("draft DSpark").
2. **GLM-5.3-Flash.** `hasMtp` accetta anche `model.language_model.layers.<num_hidden_layers>.`; la recipe GLM-5.3-Flash
   usa `{"method":"mtp",…}` (vLLM v0.30.0 registra Glm5NextMTPModel), quindi resta `mtp`.
   Fixture reali per tutti i 14 modelli (`test/fixtures/hf/model-sets/`: config.json completo ed estratto del
   weight_map con prime chiavi, chiavi `mtp.*` e dello strato nextn) e test di coerenza: `mtp` e `draft` del set ==
   `hasMtp`/`draftKind` del planner su ciascuna fixture.
3. #5 MiniMax-M2.7 AWQ: `format: "compressed-tensors"`, variante "AWQ W4A16".
4. Campo `draft` (`mtp`/`dspark`/null) nel set e in `plan.mtp.draft` (derivato anche da `method` di
   `--speculative-config`); `mtpLabel` → "DSpark attivo (… N token per passo)" / "draft DSpark presente nei pesi ma
   disattivato"; CLI e PlanView mostrano la riga "Draft:" per DSpark; colonna MTP di `search --set` e badge delle
   schede: "DSpark".
5. Avvisi delle recipe nelle regole (non argomenti automatici): V4 `--kv-cache-dtype fp8`, `--block-size 256`
   (e `--trust-remote-code` solo con `--allow-trust-remote-code`); V4.1 su H100 `--engram-config '{"cpu_offload":true}'`
   e `--max-num-batched-tokens 4096`, verifica adattiva disattivata su AMD.
6. Avviso NVFP4 (quant_algo NVFP4 o formato nvfp4-*) se la GPU scelta non è Blackwell (B200/B300/GB200/GB300,
   RTX PRO 6000, RTX 50xx); `plan.model.quantization`; l'avviso si rigenera in `applyGpuChoice`.
7. Avviso del set in `plan <set>/<n>` (stderr), `POST /api/plan` (`setWarning`) e `search --set … --json`
   (ora `{ set, name, warning, models }`).
8. Id breve stabile `key` per ogni modello (validato, unico, non solo cifre): `plan <set>/<key>` oltre a
   `<set>/<n>` (posizionale, documentato); colonna "Id" in `search --set`.
9. README: i due `--set` (set di modelli in `search`, argomento vLLM in `plan`).
10. Web: durante un calcolo gli altri "Calcola il piano" (schede e modulo) sono disabilitati; link
    "Pagina su Hugging Face" (`https://huggingface.co/${encodeURI(id)}`, target _blank, rel="noopener noreferrer").
11. README: DSpark, criteri del draft head, avvisi delle recipe, fixture di coerenza.

## Verifica

- `npm test`: 77 file, 925 test JS verdi + 31 test Python OK (dopo il rebase e le correzioni).
- `npm run build:web`: verde.
- Nuovi test: `test/core/model-sets-drafts.test.js` (fixture reali: coerenza set/planner, DSpark 0731 e V4.1, prefisso GLM-Flash, avvisi recipe, NVFP4), `test/core/model-sets.test.js` (schema, dati reali, parser coerenti con parsers.json, MTP per
  famiglia, riferimenti `<set>/<n>`), `test/cli/cli-model-sets.test.js`, `test/web/model-sets.test.jsx`,
  casi in `test/core/vllm-args.test.js`, `test/core/plan.test.js`, `test/server/api.test.js`.

## Dubbi e limiti

- La stima della KV cache di DeepSeek-V4/V4.1 (attenzione compressa, `head_dim` 512 con 1 testa KV) e di
  qwen4_exp usa la formula generica del planner: non verificata su questi modelli, potrebbe sovrastimare.
- DeepSeek-V4/V4.1 con DSpark: argomenti presi dalle recipe ufficiali e architettura/draft presenti nel registro di
  vLLM v0.30.0 (DSparkDraftModel, DSparkV41DraftModel), ma l'avvio reale non è stato provato.
- NVFP4 (ModelOpt): nativo su Blackwell; su Hopper vLLM usa kernel di ripiego più lenti (indicato nelle note).
- Le varianti orcarouter (le più scaricate per GLM-5.3-Flash e Qwen3.8-27B) sono gated "auto": escluse
  perché non verificabili senza token; con HF_TOKEN e accesso approvato restano utilizzabili per id.
- `revision` fissa la sha verificata: aggiornamenti dei pubblicatori vanno ricontrollati a mano.
- Il prezzo non è nel set (dipende dalla disponibilità Runpod): lo dà il piano, con GPU e alternative.
