# Máscaras P&B de vídeo por prompt (DeLeon Mask)

The user sends a video and types, in plain Portuguese, which part should become a matte
("a pessoa", "o carro sem as rodas", "só o homem da esquerda"). Deliver black-and-white masks
frame-locked to the original: **same frame count, same fps, same resolution, same timecode**,
white = selected, black = rest.

## Stack (all open weights, downloaded from GitHub releases — HuggingFace is blocked in the cloud)
- **YOLOE-11 (s/l) seg** — open-vocabulary detector driven by text (MobileCLIP text encoder,
  `mobileclip_blt.ts`). Needs `openai-clip` from PyPI only for the tokenizer (the git
  install that ultralytics tries by itself is refused in the cloud — install `openai-clip` first).
- **SAM 2.1 (tiny / base)** — crisp masks from the detector's boxes; its video predictor
  propagates with memory.
- `scripts/deleon_mask.py` (single file) + `scripts/setup_mascara.sh` (deps + 5 weights, ~0.9 GB).
  Weights are looked up in `$DELEON_MASK_MODELS` or `scripts/models/`.

## Commands
```bash
bash scripts/setup_mascara.sh ~/mask_models && export DELEON_MASK_MODELS=~/mask_models
python3 scripts/deleon_mask.py IN.mp4 --prompt "pessoa, -microfone" --out OUT/
```
Prompt: comma-separated targets; PT terms are translated (`PT_EN` table, unknown words pass
through — prefer English for anything unusual, the detector only understands English). `-x`
subtracts x. Gendered/age words (homem, mulher, criança) map to `person`: the detector is weak on
them — pick the instance instead.

| Need | Flags |
|---|---|
| everything matching, objects entering/leaving | default `--engine frame` (detect + SAM per frame, `--hold 4` bridges missed frames) |
| one hero object, steadiest edges | `--engine video` (SAM 2 memory, seeded on the best frame, propagated forward AND backward) |
| "only that one" | `--listar` → look at `*_deteccoes_fN.jpg` (numbered boxes) → `--pick 1,3` |
| exact region the detector cannot name | `--box "x1,y1,x2,y2@frame"` (or `rotulo=…@frame` for subtraction targets) |
| speed draft | `--quality rapido` (YOLOE masks only, ~0.7 s/frame 1080p on 2 CPUs) |
| best edges | `--quality max` (SAM 2.1 base) |
| matte finishing | `--grow ±px`, `--feather σ`, `--fill-holes`, `--min-area`, `--smooth N` (±N frame average), `--invert` |
| one matte per target | `--separar` (subfolders) |
| cut-out with alpha | `--recorte` (ProRes 4444 + alpha of the original) |

Outputs in `OUT/`: `*_mascara.mp4` (H.264 CRF 8), `*_mascara_prores.mov` (ProRes 422 HQ),
`*_mascara_png/` + `.zip` (8-bit gray, `_00000.png` = frame 0 of the original), `*_previa_overlay.mp4`
(red tint + mask side by side, ≤960 px), `*_folha_contato.jpg`, `*_relatorio.json` (per-frame
coverage + detections + verification). The script exits 2 if frame count / fps / size differ.

## Frame lock (why it holds)
Decode with `-fps_mode passthrough` (one raw frame per coded frame, rotation applied), write each
mask at the source `r_frame_rate`, copy the timecode, BT.709 tags. Verified with
`ffprobe -count_frames` on the original and on the written file. VFR sources (ratio r/avg > 2 %)
come out CFR — say so; if the user needs VFR timing, re-time in the NLE or offer to remux.

## Speed (cloud: 2 CPUs, no GPU)
frame engine alta ≈ 4.5 s/frame at 1080p · rapido ≈ 0.7 s/frame · video engine ≈ 7 s/frame.
Tell the estimate before long jobs (10 s @ 30 fps ≈ 20–35 min at `alta`). The same script runs
on the user's machine (CUDA / Apple MPS auto-detected) — far faster for long clips.

## Workflow in chat
1. Receive the video; `ffprobe` it; say size/fps/frames and the estimate.
2. Translate the user's words into targets; if they point at a specific instance, run `--listar`,
   LOOK at the numbered frame and pick the ids yourself (ask only if ambiguous).
3. Short test first on long clips (`ffmpeg -t 2`), check the contact sheet, then the full run.
4. Check `verificacao.ok`, look at the contact sheet and a full-res crop of the hardest edge.
5. Deliver the ZIP of PNGs + MP4/ProRes + overlay preview; offer finishing (grow/feather/smooth)
   and the alpha cut-out.

## Known limits / next improvements
- Detector misses descriptive phrases ("homem de camisa branca") → use `--listar/--pick`.
- Frame engine: a new SAM pass per frame → slight edge boil on hair; `--smooth 1` or engine video.
- Engine video tracks only objects present on the key frame; for many entering objects use frame.
- Thin structures (hair strands, smoke) need a matting pass — candidate upgrade (e.g. ViTMatte).
- Browser/GPU version (like the rest of this skill) is possible if the weights are hosted as
  artifact assets; not built yet.

## Browser app — DeLeon Mask (the user's main interface)
Published artifact: https://claude.ai/artifact/6bUPrG8jaHKcbdNzkfBtPM (source in
`assets/deleon-mask-app/index.html`). Upload a video → type the prompt → "Testar neste frame"
(numbered objects, click to mark) → "Gerar máscaras" → one ZIP (MP4 with the source's exact frame
timestamps + 8-bit gray PNG sequence + report). Runs on the viewer's GPU (WebGPU) or CPU (WASM).
How it is built (redo when the model changes):
- `export_tp2.py s 17` exports YOLOE-11s-seg with the text embeddings as an INPUT (`tpe` [1,8,512],
  8 fixed slots — K is baked into reshapes, pad by repeating), precomputes reprta+normalised
  embeddings for 4,596 vocabulary terms (`vocab_pe` f16) — no text encoder in the browser.
  `webify.py` drops the now-redundant normalisation; onnxslim.
- Artifact CSP: only scripts from CDNs; every binary must be a served type ≤15 MB → model and ORT's
  jsep wasm are split into `*.partN.wasm` and joined in JS; `ort.env.wasm.wasmBinary` + `wasmPaths.mjs`
  on jsdelivr. ort.webgpu bundle 1.20.1; WebGL EP gave wrong numbers — not used.
- Exact frames: mp4box demux + VideoDecoder; chunks keep sample cts; encoder re-uses each frame's
  timestamp → mp4-muxer. If the browser drops a frame (seen with B-frame MOVs in headless Chromium),
  the gap is filled with the neighbour's mask at the missing timestamp and reported.
- Mask: proto 160 → per-object sigmoid inside the box → canvas upscale ("lighten"), "Alta" = second
  pass on a zoomed crop of the 6 largest objects; threshold at 0.5, guided filter on the frame's luma
  (r ≈ 4 px @1080, eps 2e-4) + levels (−0.2/0.6) to kill the halo; grow/shrink, feather, ±N temporal.
- "Só os marcados": a detection-only pass tracks each marked box (IoU) forward and backward from the
  tested frame, then the mask pass follows it.
- Headless test: route the CDN URLs to node_modules in Playwright, hide navigator.gpu to force WASM.
