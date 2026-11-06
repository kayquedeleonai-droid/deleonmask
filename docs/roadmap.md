# Roadmap — máscaras mais precisas e limpas

Diagnóstico (v1, cena07 4K): borda irregular (contorno vem de uma grade 160×160 ampliada),
"fervura" e ilhas que piscam entre as mãos (cada frame resolvido do zero, sem memória),
rastros finos na borda da cabeça (filtro guiado sangrando em fundo de cor parecida).

1. **Pins + caixa + SAM 2** — pin verde/vermelho e caixa no app; o texto acha, os pins corrigem.
2. **Propagação com memória (SAM 2 video) + correção por keyframe** — elimina a maior parte do tremido.
3. **Matting de borda** (trimap da máscara → modelo de matting só na faixa da borda) — cabelo, motion blur.
4. **Limpeza temporal guiada por movimento** (fluxo óptico), remoção de ilhas/buracos, alerta de frames suspeitos.
5. **Revisão e exportação** — onion skin, pincel, ProRes 4444, máscara por objeto, projeto After Effects.

Arquitetura: app = direção (pins, prévia por keyframe); motor pesado = render final com os mesmos pins.

## Feito (v2 — rastreamento)
- Cada objeto é seguido pelo SAM com a máscara do frame anterior como guia (mask_input) + caixa do
  texto suavizada; se a confiança cai, recomeça só com a caixa. Frente a partir do frame analisado e
  depois para trás (frames anteriores guardados em JPEG na memória).
- Pins viram **peças**: Pin − cria um pedaço a tirar (o menor recorte coerente em volta do clique,
  ex.: o microfone), Pin + um pedaço a somar; clicar numa peça refina a peça. Caixa = objeto manual.
- Limpeza por objeto: remove ilhas soltas (mantém a maior + as ≥15% dela + as que têm pin), fecha furos < 1%.
- Acabamento separado (expandir, suavizar, estabilizar, inverter): "Aplicar acabamento" sem rastrear de novo.
- Alerta de frames suspeitos (salto de área) no relatório e na tela.
- Recortador: **SAM 2.1 tiny** com placa de vídeo (fp16 se a GPU tem shader-f16), **MobileSAM** no processador.
  Teste de 20 s ao carregar: se o SAM 2.1 não roda bem, cai para o MobileSAM.

Medição (clipe de teste 1080p, 11 frames, pessoa gesticulando): pixels que mudam entre frames
1,60% → 0,92% da área (pico 3,75% → 1,71%).

Achados: MobileSAM quebra em "xadrez" com texturas finas (tela de cadeira) e com imagem ampliada;
SAM 2.1 no mesmo recorte dá contorno sólido. SAM 2.1 no WASM (sem GPU) não termina um frame em 30 min
nesta máquina — só GPU. Recorte nunca amplia mais que 1,25×.

## Próximo
- Keyframes de correção (pins em vários frames, repropaga a partir de cada um).
- Memória de vídeo completa do SAM 2 (memory attention) no motor da nuvem/local para os finais.
- Matting de borda (cabelo).
