# DeLeon Mask

Máscaras preto e branco de vídeo a partir de um prompt ("pessoa, -microfone"), frame a frame,
com o mesmo número de frames, os mesmos tempos e a mesma resolução do original.

- **App no navegador** (`public/`) — publicado em **mask.kayquedeleon.app**. Roda na placa de vídeo
  (WebGPU) ou no processador (WASM com várias threads). O vídeo não sai da máquina.
- **Motor pesado** (`engine/deleon_mask.py`) — YOLOE + SAM 2.1 com memória, ProRes, PNG, recorte com
  alfa. Roda na nuvem do Claude ou no seu computador (CUDA / Apple MPS).

## Estrutura
| Pasta | O quê |
|---|---|
| `app/index.src.html` | fonte única do app |
| `app/build.py` | gera `public/index.html` (site) e `artifact/index.html` (artefato do Claude) |
| `public/` | o que vai para o Cloudflare: app, `_headers`, modelo em partes (`m/`), libs (`vendor/`) |
| `engine/` | pipeline Python + exportação do modelo para o navegador |
| `docs/` | documentação técnica e roadmap |

## Rodar local
```bash
python3 app/build.py
npx wrangler dev          # ou qualquer servidor estático em public/ com os cabeçalhos de _headers
```

## Deploy (Cloudflare)
`wrangler.jsonc` publica `public/` como Worker de arquivos estáticos e liga o domínio
`mask.kayquedeleon.app`. Com o repositório conectado no painel (Workers & Pages → Import a
repository), cada push na `main` publica sozinho. Sem build: o comando de deploy é `npx wrangler deploy`.

`_headers` liga o isolamento entre origens (COOP/COEP) para o WASM usar várias threads.

## Motor pesado
```bash
bash engine/setup_mascara.sh ~/mask_models && export DELEON_MASK_MODELS=~/mask_models
python3 engine/deleon_mask.py video.mp4 --prompt "pessoa, -microfone" --engine video --out saida/
```
Veja `docs/mascaras-video.md`.
