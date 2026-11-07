# DeLeon Mask

Máscaras preto e branco de vídeo a partir de um prompt ("pessoa, -microfone"), frame a frame,
com o mesmo número de frames, os mesmos tempos e a mesma resolução do original.

- **App no navegador** (`public/`) — publicado em **mask.kayquedeleon.app**. Roda na placa de vídeo
  (WebGPU) ou no processador (WASM com várias threads). O vídeo não sai da máquina.
- **Motor pesado** (`engine/deleon_mask.py`) — YOLOE + SAM 2.1 com memória, ProRes, PNG, recorte com
  alfa. Roda na nuvem do Claude ou no seu computador (CUDA / Apple MPS).

## Fluxo no app
1. **Vídeo** — abra o arquivo. 2. **Marcar** — escreva o que quer ("pessoa, -microfone"), clique pins, caixas ou
pinte com o **Pincel +** (verde, entra) e **Pincel −** (vermelho, sai). 3. **Rastrear** — gera todos os frames.
4. **Refinar** — nota por frame, piores frames, limpeza de ilhas/furos/piscadas e borda colada na imagem, com
comparação antes/depois. 5. **Exportar** — ZIP com MP4 + PNG por camada, ou projeto para o motor pesado.

## Estrutura
| Pasta | O quê |
|---|---|
| `app/ui.html` + `app/js/*.js` | fonte do app (interface, motor, vídeo, visão, rastreamento) |
| `app/build.py` | monta `public/index.html` |
| `engine/pack_models.py` | empacota os modelos com hash no nome + `public/models.json` |
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

## Render final a partir do app
No app: Exportar → **Salvar projeto (.json)**. Depois:
```bash
python3 engine/deleon_mask.py VIDEO.mp4 --projeto VIDEO_projeto.json --sam l --out saida/
```
SAM 2.1 em modo vídeo (memória completa), ProRes 422 HQ + MP4 + PNG por camada e a combinada.

## Motor pesado (sem app)
```bash
bash engine/setup_mascara.sh ~/mask_models && export DELEON_MASK_MODELS=~/mask_models
python3 engine/deleon_mask.py video.mp4 --prompt "pessoa, -microfone" --engine video --out saida/
```
Veja `docs/mascaras-video.md`.
