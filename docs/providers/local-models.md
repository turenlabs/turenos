# Local models

## Bonsai 2

The [Bonsai-2 collection](https://huggingface.co/collections/prism-ml/bonsai-2)
currently publishes these checkpoints:

- `prism-ml/Ternary-Bonsai-2-27B-gguf` — PrismML's custom `PTQ1_0` and `PQ2_0`
  GGUF files for the PrismML llama.cpp fork.
- `prism-ml/Ternary-Bonsai-2-27B-mlx-2bit` — MLX safetensors that require the
  bundled Hadamard-aware loader in the repository's `runtime/` directory.
- `prism-ml/Ternary-Bonsai-2-27B-gguf-dev` — a testing `Q2_0` build that also
  requires the PrismML fork.

These artifacts are not currently vLLM checkpoints. Bonsai uses a Qwen3.8
hybrid-attention architecture, custom ternary weight types, and a Hadamard
activation transform. Current vLLM Metal GGUF support is limited to dense
Qwen/Llama/Mistral-style models and standard `Q8_0`, `Q4_0`, or `Q4_1` tensors;
hybrid models, custom qtypes, and vision GGUFs are rejected. The MLX artifact's
`prism_hadamard_qwen35` model type likewise needs its bundled loader. Do not
serve these files with stock `vllm`, `vllm-gguf-plugin`, or stock llama.cpp:
loading the testing `Q2_0` file without the activation transform can produce
gibberish without an error.

The supported local path on Apple Silicon is the
[PrismML Bonsai demo](https://github.com/PrismML-Eng/Bonsai-demo), which uses
the PrismML llama.cpp fork and exposes an OpenAI-compatible API.

### Install and run the server

The following downloads the 27B `PQ2_0` model and vision projector, but skips
the optional MLX, Open WebUI, and code-interpreter environments:

```bash
git clone https://github.com/PrismML-Eng/Bonsai-demo.git
cd Bonsai-demo
BONSAI_FAMILY=bonsai2 BONSAI_MODEL=27B BONSAI_SKIP_MLX=1 \
  BONSAI_OPENWEBUI=0 BONSAI_CODE_INTERPRETER=0 ./setup.sh
BONSAI_CTX=16384 ./scripts/start_llama_server.sh --alias bonsai-2-27b
```

The server listens on `http://127.0.0.1:8080` and provides the OpenAI-compatible
endpoint at `http://127.0.0.1:8080/v1`. Keep the bind address on loopback unless
the server is explicitly being protected before exposing it to another host.
The launcher's context default is hardware-dependent; `16384` is a conservative
starting point for a 24 GB Apple Silicon machine. Increase it only after
checking memory pressure. On Metal, large image inputs are capped at roughly
1024 vision tokens by default; set `BONSAI_IMAGE_MAX_TOKENS=0` when fine detail
or OCR is more important than latency.

Check the endpoint before configuring a client:

```bash
curl http://127.0.0.1:8080/v1/models
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"bonsai-2-27b","messages":[{"role":"user","content":"Hello"}],"max_tokens":64}'
```

### Use Bonsai from TurenOS

Add a custom provider to the global `forge.json` or `forge.jsonc` in the
TurenOS config directory (`$XDG_CONFIG_HOME/forge`, by default
`~/.config/forge`, or `FORGE_CONFIG_DIR` when set). The `provider` spelling below is the existing v1
configuration form accepted by TurenOS; the model reference is
`bonsai-local/bonsai-2-27b`.

```json
{
  "$schema": "https://github.com/turenlabs/forge/config.json",
  "model": "bonsai-local/bonsai-2-27b",
  "provider": {
    "bonsai-local": {
      "name": "Bonsai 2 (local llama.cpp)",
      "npm": "@ai-sdk/openai-compatible",
      "api": "http://127.0.0.1:8080/v1",
      "options": {
        "apiKey": "local"
      },
      "models": {
        "bonsai-2-27b": {
          "name": "Bonsai 2 27B",
          "family": "qwen3.8",
          "attachment": true,
          "reasoning": true,
          "temperature": true,
          "tool_call": true,
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": {
            "context": 16384,
            "output": 4096
          },
          "status": "active"
        }
      }
    }
  }
}
```

Restart or refresh the provider list after changing the config. The server must
be running before TurenOS sends a request. The `--alias bonsai-2-27b` flag keeps
the model ID stable even though the downloaded GGUF filename may change.

## If vLLM is required

On Apple Silicon, `vllm-metal` can serve compatible MLX checkpoints, but it does
not add support for Bonsai's custom ternary runtime. On CUDA/Linux, the vLLM
GGUF plugin is experimental and the published Bonsai files still use unsupported
custom qtypes and hybrid attention. A future PrismML artifact explicitly marked
as vLLM-compatible would be a different checkpoint; until then, use the
llama.cpp path above for Bonsai or choose a model in vLLM's supported-model
matrix.

References:

- [Bonsai 2 model card](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf)
- [Bonsai demo](https://github.com/PrismML-Eng/Bonsai-demo)
- [vLLM Metal supported models](https://docs.vllm.ai/projects/vllm-metal/en/latest/supported_models/)
- [vLLM GGUF support](https://docs.vllm.ai/en/latest/features/quantization/gguf/)
