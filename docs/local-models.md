# Running local models

Everything needed to run this fully offline against a GPU, plus the environment
facts that actually constrain the work.

- [Environment](#environment)
- [Windows (native) environment](#windows-native-environment)
- [Running a local model](#running-a-local-model)
- [Payload](#payload)
- [Choosing a model](#choosing-a-model)

---

## Environment

The current setup. Everything under "Historical" is kept for context.

| Fact | Value |
| --- | --- |
| OS | Windows 11, native (no WSL, no Linux paths) |
| GPU | **Intel Arc Pro B60** — Ollama reports `100% GPU` |
| GPU also present | GTX 1080 Ti (Pascal, compute 6.1) — **not used**; not the active adapter here |
| Node / Python | 24.18.1 / 3.14.6 |
| Ollama | 0.40.2, portable install at `E:\lm_studio_projects\tools\ollama` |

### Historical: the WSL2 setup

The project began on WSL2 and moved to native Windows. Kept because several
lessons are specific to it.

| Fact | Value |
| --- | --- |
| OS | WSL2, Ubuntu 26.04.1, glibc 2.43 |
| CPU | **Intel i9-9900K @ 3.60GHz (Coffee Lake) — AVX2 + FMA + F16C** |
| CPU / RAM | 8 cores / 16 threads · 15 GB |
| GPU | **GTX 1080 Ti, 11264 MiB**, driver 580.159.06 (Pascal, compute 6.1) |
| 3D accel in WSL | **yes** — WSLg D3D12, GL 4.6. Headed Chromium reports `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce GTX 1080 Ti))` |
| CUDA from WSL | driver API 13000, `cuInit -> 0`, device visible |

Consequences worth remembering:

- **Keep project files on `/` (ext4).** `/mnt/c` is a slow 9p mount that breaks
  file watching.
- **There was no Linux `npm` on that box** — only `/usr/bin/node`. Every `npm` on
  `PATH` resolved to the Windows one under `/mnt/c/Program Files/nodejs`, which
  shells out to `cmd.exe`, cannot `cd` to a WSL UNC path, and silently runs
  scripts from `C:\Windows`.
- **Headless Chromium has no GPU** — it falls back to SwiftShader (or llvmpipe).
  Real acceleration only happens headed, on the WSLg display (`DISPLAY=:0`).
- Dependency versions are pinned: `three@0.186.1`,
  `@dimforge/rapier3d-compat@0.21.0`.

---

## Windows (native) environment

Ollama is a **portable install, not a Windows service**, so it must be started by
hand after a reboot:

```
E:\lm_studio_projects\tools\start-ollama.cmd
```

It starts `ollama serve` on **port 11435** — the same port `.env` already used —
so no config changes were needed. `OLLAMA_HOST=127.0.0.1:11435` is persisted in
the user environment.

Verify end to end (proxy + static server + real model driving the ball):

```
npm run serve          # static server on :8080
npm run start          # LLM proxy on :8787
npm run check:ollama   # real browser, real model, prints intents + errors
```

The first two must be running in separate shells — the check drives a real
browser against the static server and reports the intents it issued, the distance
travelled and any page errors. `scripts/live-browser-check.mjs` is the same idea
against a hosted provider.

Two things break on Windows that did not break on WSL, both fixed in the repo:

- `scripts/serve.py` — the Windows registry maps `.js` to `text/plain`, so the
  browser rejects every ES module. `mimetypes.add_type("text/javascript", ".js")`.
- `test/ollama-modes.test.mjs` — libuv aborts if the process exits with an HTTP
  handle still closing.

`python` and `python3` on `PATH` are Microsoft Store stubs here; use the project
venv at `.venv`, which `npm run serve` already points at.

---

## Running a local model

The whole thing runs offline on the GPU. `.env`:

```
LLM_PROVIDER=ollama
LOCAL_BASE_URL=http://127.0.0.1:11435/v1
LOCAL_MODEL=qwen3:4b
LOCAL_INTENT_MODEL=qwen3:4b
LOCAL_INTENT_MAX_TOKENS=120
LOCAL_CHARACTER_MAX_TOKENS=6000
```

`LLM_PROVIDER=ollama` is **not** a synonym for `local` — it selects Ollama's
**native** `/api/chat` rather than the OpenAI-compat `/v1`, and that is the whole
point: the thinking-mode toggle is honoured on one and ignored on the other.

The token budgets are per-purpose because the two jobs are opposites — an intent
is polled every 2s, a character is designed once per maze. **6000 is measured
against the real prompt, not guessed:** 1500 was not enough (5243 chars of
scratch work, no answer), 6000 converges with ~7000 chars in 33–63s, and 9000
makes it ramble far enough to invent a radius of 12.

### Two ollama request slots, and that is load-bearing

With the default of 1, a slow thinking-mode design call serialised against the
control loop: a 0.65s intent took **40–45 seconds** to answer while a design was
in flight, and the HUD's average round trip read 11.8s instead of 0.65s. The
character simply stopped being steered. `OLLAMA_NUM_PARALLEL=2` fixes it —
measured warm, intents stay at **0.64–0.89s** throughout a 47s design.

**The fix is not to make the design faster; it is to stop it blocking steering.**

The `local` provider already spoke Ollama's OpenAI-compatible endpoint, so **no
code change was needed** — only `.env`.

### A GPU that `nvidia-smi` can see is not a GPU the stack will use

The WSL-era ollama snap was CPU-only, and it was not obvious why. The snap only
offers the CUDA **v13** payload, and that build is compiled for compute
capability 7.5 and up. A GTX 1080 Ti is 6.1, so discovery skipped the card and
fell back to the CPU without saying much:

```
skipping CUDA device — compute capability not in compiled architectures
  device="NVIDIA GeForce GTX 1080 Ti" cc=610
  archs="[750 800 860 870 890 900 1000 1030 1100 1200 1210]"
```

The release tarball also ships **`cuda_v12`**, which *is* built for `sm_61`, and
the unpacked binary finds it on its own:

```
inference compute id=0 library=CUDA compute=6.1 name=CUDA0
  description="NVIDIA GeForce GTX 1080 Ti" total="11.0 GiB" available="10.0 GiB"
```

So: do not judge GPU support from `nvidia-smi` working, and do not trust
`ollama ps` without reading `PROCESSOR`. Unpacked:

```bash
curl -L -o ollama.tar.zst \
  https://github.com/ollama/ollama/releases/download/v0.34.0/ollama-linux-amd64.tar.zst
# no zstd CLI on this box; libzstd.so.1 is present, so decompress via dlopen
tar xf - -C ~/opt/ollama  # after piping through a libzstd decompressor
~/opt/ollama/serve-gpu.sh &
ollama ps          # PROCESSOR must read "100% GPU"
```

Port **11435** so it does not fight the snap for 11434. Its model store is
separate from the snap's, because `/var/snap/ollama/common/models` is root-owned
and `ollama pull` fails there with `permission denied`.

**LM Studio is not installed** — only a leftover `lms.exe` CLI and an updater
directory. Its local server would work the same way (`lms server start`, point
`LOCAL_BASE_URL` at it), but it buys nothing here that ollama does not.

---

## Choosing a model

Measured on the current machine (Intel Arc Pro B60, 100% GPU, ~80 tok/s) by
`npm run bench:local`, which benchmarks **through the proxy** so extraction and
sanitising are inside the measurement:

| Model | Intent latency | Character generation | Goal selection | Success rate |
| --- | --- | --- | --- | --- |
| `qwen3:1.7b` | **0.24s** | 2.9s | **0/5** | **0%** |
| `qwen3:4b` | 0.68s | 49.1s (thinking on) | **5/5** | **100%** |

**The faster model is the useless one.** `qwen3:1.7b` chose the goal zero times
out of five — and needed **zero** sanitiser intervention. Its output was
perfectly valid JSON that simply did the wrong thing: the "schema-valid and
inert" failure mode, reproduced with fresh data.

That is the single most useful thing this table says, and it is why latency is
no longer the interesting axis. The 4B answers 3x slower and works.

Historical measurements on the WSL2 / GTX 1080 Ti box, kept for comparison:

| Configuration | Intent latency | Mazes unaided | Notes |
| --- | --- | --- | --- |
| 1.5B, **CPU only**, software-rendered browser | 1.14–1.23s | **5/5** | the weak-hardware case |
| 1.5B, GPU | ~0.35s | **6/6** | |
| 7B, GPU | 0.52–0.65s | **4/4** | picks `charge_target → goal` 10/10 |
| `gpt-oss:20b`, GPU + RAM | **15.9s** resident | — | too slow to be a control loop; shows reasoning |
| Manual intent channel | ~0.3s | — | instant, but not a model |

Simulation time tracked wall clock exactly in every one of these, including the
CPU-only run, which is the contention case the old hardware could not survive.

### One integration caveat, measured not assumed

**Ollama accepts `response_format: {type: "json_schema", …, strict: true}` with
HTTP 200 and then ignores the numeric bounds.** It answered `intensity: 5` (max
1) and `duration_s: 30` (max 10), on both its OpenAI-compatible and its native
`/api/chat?format=` endpoint. The project's sanitiser clamps those correctly
(`5→1`, `30→10`), so the system stays safe — but treat "the provider returned
200" as evidence of nothing, and lean on `sanitizeSpec`/`sanitizeIntent` rather
than on the schema.

---

## Payload

| Dependency | Raw | Gzipped |
| --- | --- | --- |
| `three` | 648 KB | ~150 KB |
| Rapier `-compat` (WASM inlined as base64) | 4.2 MB | **1.6 MB** |

Rapier dominates and is the biggest cost in the project. If load time matters,
the mitigations in order of effort are: serve the non-`-compat` build with a real
`.wasm` file, lazy-load after first paint, or drop to a smaller physics library.