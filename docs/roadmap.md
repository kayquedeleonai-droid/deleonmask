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

## Feito (v3 — sistema completo)
- **Interface nova**: etapas (Vídeo, Marcar, Rastrear, Exportar), ferramentas à esquerda (atalhos V/A/S/B,
  espaço, ←/→, Ctrl+Z), monitor com HUD, linha do tempo com cobertura por camada, marcações e frames a revisar.
- **Predefinições com passes**: Livre, Pessoa (matting), Carro (carroceria, rodas, vidros, sombra), Produto (produto, mãos).
  Ajustes que funcionaram ficam guardados por predefinição.
- **Partes dentro do inteiro**: rodas/vidros só contam dentro da carroceria e são descartados se tiverem o tamanho do carro.
- **Keyframes de correção**: pins e caixas em qualquer frame; cada marcação nasce naquele frame e segue para frente e para trás.
  Antes do primeiro rastreamento, o frame é analisado pelo texto para os pins terem onde cair.
- **Detector grande YOLOE-L** (padrão com placa de vídeo) + vocabulário ampliado (roda do carro, retrovisor, carroceria…).
- **Matting de pessoas (RVM)** combinado com o SAM: a borda e o cabelo vêm do RVM, a escolha da pessoa vem do SAM.
- **Estabilização sem rastro**: só faz média onde o pixel quase não muda (movimento real fica intacto).
- **Projeto → motor pesado**: `--projeto` renderiza com SAM 2.1 (t/s/b/l) em vídeo, ProRes por camada.

Testes (navegador sem GPU): carros vistos de cima (40 frames, 2 carros entrando/saindo), palestrante com microfone
(correção no frame 8 propagada para 0–10), pessoa com matting. Não disponível: SAM 3 (pesos com acesso restrito).

## Feito (v3.1 — pincel e refino)
- **Pincel + / Pincel −** (atalhos G / R, `[` `]` para o tamanho, Alt inverte): pinta-se por cima, estilo Roto Brush.
  O traço vira a máscara inicial do SAM (mask_in) mais pontos ao longo dele, então encaixa na borda da imagem.
  Verde sem objeto embaixo cria um objeto novo na camada ativa; vermelho tira do objeto que o traço cobre.
  Nasce no frame pintado e segue para frente e para trás.
- **Etapa Refinar** (aba Refino): depois de gerar, cada frame recebe uma nota 0–100 com quatro critérios —
  ilhas soltas, furos, piscadas (pixel que acende/apaga num frame só) e borda × imagem (a borda da máscara cai
  sobre uma borda real do vídeo?). Lista dos piores frames com o motivo; faixa vermelha/âmbar na linha do tempo.
- **Refinar máscaras**: remove ilhas menores que X% do objeto, fecha furos, vota piscadas por maioria em ±N frames
  e cola a borda nas bordas da imagem (filtro guiado). Recalcula a nota e mostra antes → depois.
  Segure **C** ou o botão "Antes do refino" para comparar; vista **Contorno** desenha a borda da máscara sobre o vídeo.
