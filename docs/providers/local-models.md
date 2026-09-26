# Local models

TurenOS can use a model served on this machine through any OpenAI-compatible endpoint, configured as a custom provider
in `forge.json`, and it discovers local Ollama and llama.cpp servers on its own. The model server is run and secured by
you; TurenOS only sends requests to it. This page covers background discovery and the Bonsai 2 path. Its statements
about third-party checkpoints and runtimes were checked on 2026-09-18 and may drift.

## Background discovery

Two built-in provider plugins, `packages/core/src/plugin/provider/ollama.ts` and
`packages/core/src/plugin/provider/llama-cpp.ts`, probe loopback servers when the provider catalog loads, then keep
polling every 10 seconds while it stays loaded. They run without any configuration.

| Provider ID | Default endpoint         | Override                                                     | Requests                       |
| ----------- | ------------------------ | ------------------------------------------------------------ | ------------------------------ |
| `ollama`    | `http://127.0.0.1:11434` | a configured `ollama` provider endpoint, `OLLAMA_HOST`       | `GET /api/tags`                |
| `llama-cpp` | `http://127.0.0.1:8080`  | a configured `llama-cpp` provider endpoint, `LLAMA_CPP_HOST` | `GET /v1/models`, `GET /props` |

Each probe times out after 750 ms and refuses redirects. The endpoint host must be `localhost`, `127.0.0.1`, or `::1`
over HTTP(S) without credentials in the URL; any other value disables that plugin rather than dialing a remote host. A
reachable server registers the provider with its listed models (text-only, tools enabled, zero cost, 32,768-token
context unless llama.cpp's `/props` reports `n_ctx`, 8,192-token output). A server with no models still registers with
an empty list. When a later poll sees a different model list or no answer, the catalog reloads, so a stopped server
drops out of the list.

The OpenCode provider plugin makes one further background request, but only when an OpenCode Console connection
exists: at catalog load and after each connection change it fetches `/api/config` from the connection's server
(`https://console.opencode.ai` by default) with the stored token and registers the providers it returns
(`packages/core/src/plugin/provider/opencode.ts`).

## Bonsai 2

As of 2026-09-18, the [Bonsai-2 collection](https://huggingface.co/collections/prism-ml/bonsai-2)
publishes these checkpoints:

- `prism-ml/Ternary-Bonsai-2-27B-gguf` — PrismML's custom `PTQ1_0` and `PQ2_0`
  GGUF files for the PrismML llama.cpp fork.
- `prism-ml/Ternary-Bonsai-2-27B-mlx-2bit` — MLX safetensors that require the
  bundled Hadamard-aware loader in the repository's `runtime/` directory.
- `prism-ml/Ternary-Bonsai-2-27B-gguf-dev` — a testing `Q2_0` build that also
  requires the PrismML fork.

These artifacts were not vLLM checkpoints as of that date. Bonsai uses a Qwen3.8
hybrid-attention architecture, custom ternary weight types, and a Hadamard
activation transform. At that date vLLM Metal GGUF support was limited to dense
Qwen/Llama/Mistral-style models and standard `Q8_0`, `Q4_0`, or `Q4_1` tensors;
hybrid models, custom qtypes, and vision GGUFs were rejected. The MLX artifact's
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

Because the demo server listens on llama.cpp's default port, background
discovery also lists it as `llama-cpp/bonsai-2-27b`, with text-only input and
the context `/props` reports (32,768 tokens when it reports none). Use the `bonsai-local` model above to keep the
image input and limits declared in the config.

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
