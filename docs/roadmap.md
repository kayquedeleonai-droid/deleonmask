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
