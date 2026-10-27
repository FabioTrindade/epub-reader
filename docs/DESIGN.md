# Design: especificação para implementação

Este documento descreve o novo visual do EPUB Reader. Ele é a fonte da verdade
para quem for implementar, inclusive para as telas que **não** foram desenhadas.

- **Telas desenhadas (referência visual):** https://claude.ai/artifact/9CV5o78KoBVagrReR17UP9
  (o canvas é privado; o dono precisa compartilhar o link para outras pessoas abrirem)
- **Telas no canvas:** leitura lado a lado (computador), biblioteca (computador),
  leitura com seleção (celular), dicionário (celular), biblioteca (celular),
  aparência no tema escuro (celular).

Quando o canvas e este documento divergirem, vale este documento.

---

## 1. Princípios

1. **O texto é a interface.** Na leitura, nada compete com o livro: sem bordas
   pesadas, sem sombras desnecessárias, cromo mínimo.
2. **Ações aparecem quando fazem sentido.** O que depende de seleção aparece
   junto da seleção. O que só importa quando algo dá errado fica num menu.
3. **Uma cor de destaque.** Azul para progresso, foco, estado ativo e links. O
   resto é escala de cinzas quentes. Exceções: a cor da marca "parei aqui"
   (escolhida pelo usuário) e o verde de "Concluído".
4. **Mesmos componentes no computador e no celular.** O que muda é a
   disposição: popover no computador vira painel que sobe do rodapé (bottom sheet)
   no celular.
5. **Nada de funcionalidade se perde.** Toda função listada no README continua
   acessível, com os mesmos atalhos de teclado.

---

## 2. Tokens

Manter os **mesmos nomes** de variáveis CSS que já existem em `css/styles.css`
e trocar só os valores. Variáveis novas estão marcadas com (novo).

### Cores, tema claro

| Variável | Valor | Uso |
|---|---|---|
| `--bg` | `#FBFBFA` | Fundo da página |
| `--surface` | `#FFFFFF` | Cards, popovers, painéis |
| `--surface-2` | `#F0F0ED` | Trilho do seletor de modo, campos, esqueletos de carregamento |
| `--fg` | `#18181B` | Texto principal |
| `--muted` | `#6B6B72` | Texto secundário, rótulos (contraste ≥ 4.5:1 sobre `--bg`) |
| `--border` | `#EAEAE7` | Linhas divisórias (1px) |
| `--accent` | `#3451B2` | Destaque único |
| `--accent-fg` | `#FFFFFF` | Texto sobre `--accent` |
| `--trans-bg` | `transparent` | A tradução não tem mais fundo próprio |
| `--trans-fg` | `#4A4A52` | Texto da tradução (um tom abaixo do original) |
| `--accent-soft` (novo) | `#E6EBFA` | Fundo da palavra consultada no dicionário |
| `--selection` (novo) | `#C9D6FB` | Fundo da seleção de texto (`::selection`) |
| `--success` (novo) | `#15803D` | "Concluído" na biblioteca |
| `--info`, `--warn`, `--error` | manter os atuais | Notificações e toasts |
| `--shadow` | `0 12px 32px rgba(24,24,27,.12)` | Só em elementos flutuantes |

### Cores, tema escuro

| Variável | Valor |
|---|---|
| `--bg` | `#131316` |
| `--surface` | `#1C1C21` |
| `--surface-2` | `#26262C` |
| `--fg` | `#ECECEE` |
| `--muted` | `#A0A0A8` |
| `--border` | `#26262C` |
| `--accent` | `#9DB2FF` |
| `--accent-fg` | `#131316` |
| `--trans-fg` | `#C4C4CA` |
| `--accent-soft` | `#2A3150` |
| `--selection` | `#34406B` |
| `--success` | `#5CC98A` |

Manter o mecanismo atual de tema (`prefers-color-scheme` + `[data-theme]`).

### Marca "parei aqui"

**Não mudar** o sistema atual de `--mark-hue` por `[data-mark-color]` nem a
mistura com `color-mix(... 26%, transparent)`: ele foi calibrado para manter o
texto legível nos dois temas. No canvas a marca aparece em âmbar sólido só para
ilustrar.

### Tipografia

Carregar do Google Fonts: **Literata** (400, 500, 600 e itálico 400) e
**Inter** (400, 500, 600). Manter fontes do sistema como fallback.

| Uso | Família | Tamanho / peso / altura de linha |
|---|---|---|
| Texto do livro | `--font-serif`: `Literata, Georgia, serif` | `--reader-font-size` (padrão 19px computador, 18px celular), 400, `--reader-line-height` 1.7 |
| Opção "sem serifa" | `--font-sans`: `Inter, system-ui, sans-serif` | idem |
| Título do capítulo | Literata | 36px computador / 28px celular, 500, letter-spacing -0.01em |
| Rótulo de seção ("CAPÍTULO 1", "CONTINUAR LENDO") | Inter | 11–12px, 600, maiúsculas, letter-spacing .07em, cor `--muted` |
| Interface | Inter | 14px, 400/500; títulos de painel 17px 600 |
| Texto auxiliar | Inter | 12–13px, cor `--muted` |
| Botão "Aa" | Literata | 17px |

### Espaçamento, cantos, alvos de toque

- Escala de espaçamento: 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56.
- Cantos: 8px (botões internos, chips), 10px (botões, seletor), 12–14px
  (popovers, campos), 16–18px (cards), 20px (topo do bottom sheet).
- **Alvo de toque mínimo de 44×44px** em tudo que é clicável no celular.
- Ícones: traço de 1.7–1.8px, 20px na barra, 16–18px em botões pequenos. Sem emoji.

### Pontos de quebra

Manter os atuais: `1024px` (sumário fixo à esquerda), `768px` (layout de
celular), `420px` (ajustes finos).

---

## 3. Componentes

### Topo (`.app-header`)
- Altura de cerca de 56px, fundo `--bg`, borda inferior de 1px `--border`.
- **Esquerda:** botão de sumário + título do livro (14px 600) e, abaixo,
  "Autor · Cap. N" (12px `--muted`).
- **Centro (computador):** seletor de modo.
- **Direita:** indicador "Traduzindo 62%" (só durante a tradução), botão **Aa**,
  botão de tema (lua/sol), botão Biblioteca, botão **⋯**.
- **Mudanças em relação ao HTML atual:**
  - `#btn-settings` vira o botão "Aa". O botão de tema continua no topo, como
    atalho entre claro e escuro: o leitor não encontrava o tema só no painel.
    No topo da leitura do celular ele não cabe e fica só no painel Aa.
  - `#btn-notifications` vai para dentro do menu ⋯ (itens: Notificações,
    Copiar diagnóstico, Ajuda). Quando houver aviso ou erro, mostrar um ponto
    `--accent` (ou `--error`) sobre o ⋯ e manter o `#notif-badge` dentro do menu.
- **Celular:** voltar (biblioteca) | título centralizado | Aa. O seletor de modo
  desce para baixo do topo.

### Linha de progresso da tradução
- Substitui a `.translate-bar`. É uma linha de 2px colada na borda inferior do
  topo, com largura igual ao percentual traduzido, na cor `--accent`.
- O botão **Cancelar** vai para o indicador "Traduzindo N%" do topo: clicar no
  indicador mostra "Cancelar tradução". No celular, ele fica no menu Aa.
- O parágrafo ainda não traduzido aparece como **esqueleto**: 2 barras de 12px,
  `--surface-2`, cantos de 6px, larguras de 100% e 64%. Respeitar
  `prefers-reduced-motion` (sem animação de brilho).

### Seletor de modo (`.mode-switch`, `.mobile-tabs`)
- Trilho `--surface-2`, 3px de respiro interno, cantos de 10px. Botões de 34px de
  altura (36px no celular).
- Ativo: fundo `--surface`, texto `--fg` 600, sombra `0 1px 2px rgba(0,0,0,.10)`.
  Inativo: transparente, texto `#55555C` 500.
- Rótulos: **Original · Lado a lado · Tradução** (trocar "Traduzido" por
  "Tradução"). No celular, só Original | Tradução, ocupando a largura toda.
- Usar `aria-pressed` em cada botão.

### Área de leitura
- **Lado a lado:** largura toda da área de leitura, 2 colunas iguais com 64px de
  espaço entre elas. **Cada par de parágrafos fica numa linha própria** (grid por
  parágrafo), para que original e tradução comecem sempre alinhados.
- Acima das colunas, cabeçalhos pequenos: "Inglês · original" e
  "Português (Brasil) · tradução" (12px `--muted`), com borda inferior.
- **Original ou Tradução sozinho:** coluna única na largura toda da área de
  leitura. (Decisão do leitor, que prefere aproveitar a tela: a primeira versão
  desta especificação limitava a 760px e o lado a lado a 1180px.)
- Espaço entre parágrafos de 28px (computador) e 20px (celular). Margens laterais
  de 24px no celular.
- **Trecho salvo:** uma fitinha (ícone de marcador preenchido, 16px, `--accent`)
  na margem esquerda, alinhada à primeira linha do parágrafo.

### Barra de seleção (novo)
- Aparece **sobre** o texto selecionado, cerca de 12px acima da seleção (abaixo
  dela se não houver espaço). Pílula `#18181B` com texto branco, cantos de 12px,
  botões de 40px de altura.
- Ações: **Parei aqui** (com um quadradinho na cor `--mark-hue`), **Salvar**,
  **Copiar**. Se a seleção já estiver marcada, "Parei aqui" vira **Remover marca**.
- Some com `Esc`, com clique fora ou quando a seleção é desfeita.
- Atalhos `m` e `b` continuam funcionando.
- `role="toolbar"`, com foco acessível pelo teclado.

### Rodapé (`.app-footer`)
- Computador: `‹ Anterior` | "Capítulo 1 de 135 · 2% do livro" sobre uma barra
  de 3px | `Próximo ›`. Fundo `--bg` levemente translúcido, borda superior de 1px.
- Celular: barra de progresso de 3px em toda a largura, no topo do rodapé. Abaixo
  dela: botão de sumário | "Cap. 1 de 135 · 2%" | ‹ ›.
- **Atenção:** os botões grandes "Parei aqui" e "Salvar trecho" saem do rodapé,
  mas o comportamento **sem seleção** do README (marcar o parágrafo do topo da
  tela) precisa continuar existindo:
  - pelo atalho `m`;
  - por um botão compacto só com ícone (marcador "parei aqui"), ao lado do
    rótulo do capítulo, com `aria-label` e `title` descrevendo o que o próximo
    clique faz ("Parei aqui" / "Remover marca").

### Dicionário
- **Computador:** popover de 300px de largura, `--surface`, borda de 1px, cantos
  de 14px, `--shadow`, ancorado logo abaixo da palavra.
- **Celular:** bottom sheet (ver abaixo).
- Conteúdo: a palavra (Literata 20–30px 600); a tradução principal (16–18px 500,
  `--accent` no celular); grupos por classe gramatical (rótulo em maiúsculas
  11px + sentidos). No celular, os sentidos aparecem como chips `--surface-2`.
- A palavra consultada fica com fundo `--accent-soft` e texto `--accent`
  enquanto o dicionário estiver aberto.
- Opcional (sugestão nova): a frase do parágrafo traduzido com a palavra
  correspondente em negrito.

### Bottom sheet (novo; usado no celular)
- Fundo `--surface`, cantos de 20px só em cima, alça de 36×4px no topo, fundo
  escurecido (`rgba(0,0,0,.28)` no claro, `.5` no escuro).
- Fecha arrastando para baixo, tocando fora, com `Esc` ou pelo botão ✕ de 44px.
- Implementar com `<dialog>` (já usado no projeto), com o foco preso dentro.

### Painel Aparência ("Aa")
Substitui `#dlg-settings`. É um popover ancorado ao "Aa" no computador e um
bottom sheet no celular. Na ordem:
1. **Tamanho do texto:** botões A (menor) e A (maior) com um indicador de passos
   entre eles (14 a 28px, passo de 1 → mostrar 6 pontos proporcionais).
2. **Fonte** (Aa serifada | Aa sem serifa) e **Espaçamento** (compacto 1.4 |
   normal 1.7 | amplo 2.0), lado a lado.
3. **Tema:** 3 cartões (Claro, Escuro, Sistema) com miniatura.
4. **Cor da marca "parei aqui":** 5 círculos de 44px; o selecionado tem um anel.
5. Linha **Traduzir para** › abre a lista de idiomas.
6. Linha **Armazenamento e diagnóstico** › mostra o espaço usado e leva aos
   botões "Limpar cache de traduções deste livro" e "Copiar diagnóstico".

O tema fica neste painel (com a opção "Sistema") e também no botão de lua/sol
do topo, que alterna direto entre claro e escuro.

### Biblioteca
- **Computador:** topo com a marca "EPUB Reader", o botão Aa e o botão primário
  **Adicionar livro** (fundo `--fg`, texto `--bg`).
- **Continuar lendo:** card `--surface` com cantos de 18px. Mostra capa de
  120×180, título (Literata 28px), "Autor · Capítulo N · lido há X", a frase
  marcada como "parei aqui" (com a cor da marca), uma barra de progresso de 4px
  com o percentual e o botão **Continuar de onde parei** (`--accent`).
  Aparece só se existir algum livro iniciado e não concluído; usar o mais recente.
- **Grade:** `repeat(auto-fill, minmax(180px, 1fr))`, com 28px de espaço vertical
  e 24px horizontal. Cada card tem capa 2:3 com cantos de 6px, título 600, autor
  `--muted` e o estado do livro:
  - em andamento: barra de 3px + percentual;
  - concluído: ✓ "Concluído" em `--success`;
  - não iniciado: "Não iniciado" em `--muted`.
- Último item da grade: área tracejada "Arraste um .epub ou clique para
  escolher". Arrastar um arquivo para qualquer lugar da janela também funciona.
- Remover livro: menu ⋯ no card (aparece ao passar o mouse no computador e fica
  sempre visível no celular), com confirmação.
- **Capa:** usar a imagem de capa do EPUB quando houver. Sem capa, gerar uma capa
  tipográfica: fundo de uma paleta fixa de 6 tons suaves (escolhido por hash do
  título), título em Literata 600 e autor pequeno.
- **Celular:** título grande "Biblioteca" (Literata 30px), botões Aa e + redondo,
  card Continuar lendo compacto (capa 72×108) e lista em linhas (capa 44×66).
- Busca por título ou autor: mostrar só a partir de 6 livros.
- Rodapé: "Seus livros, marcas e progresso ficam só neste navegador. Apenas o
  texto traduzido é enviado ao serviço de tradução."

---

## 4. Telas não desenhadas: como resolver

Usar os mesmos componentes e tokens. Na dúvida, seguir a regra: **superfície
`--surface`, borda de 1px `--border`, rótulo de seção em maiúsculas pequenas,
uma ação primária no máximo, textos do README.**

| Tela ou estado | Como fazer |
|---|---|
| **Sumário / Trechos salvos** (`#sidebar`) | ≥1024px: coluna fixa de 280px à esquerda, fundo `--bg`, borda direita de 1px, que abre e fecha pelo botão do topo (a escolha fica salva). Abaixo disso: painel deslizante da esquerda com fundo escurecido. Abas no estilo do seletor de modo. Capítulo atual: texto `--fg` 600 e um ponto `--accent` à esquerda; demais capítulos em `--muted`. Itens de 40px de altura (44px no celular). Trechos salvos: início do trecho em Literata 15px (2 linhas no máximo) + "Cap. N" em `--muted` + botão remover. |
| **Primeira abertura, sem livros** (`#welcome`) | Biblioteca com o estado vazio no lugar da grade: área tracejada grande (cantos de 18px, cerca de 320px de altura) com ícone, "Abra um livro em EPUB", texto de privacidade e o botão primário "Escolher arquivo". Abaixo, um link para "Onde encontrar livros gratuitos". |
| **Arrastando um arquivo** | Moldura `--accent` tracejada de 2px sobre a janela inteira, fundo `--accent-soft` a 60% e o texto "Solte para abrir". |
| **Importando um livro** | Card na grade com capa em esqueleto e "Importando…"; a tela não deve parecer travada. |
| **Voltar para onde parei** (`#btn-goto-mark`) | Pílula flutuante centralizada 16px acima do rodapé, fundo `--fg`, texto `--bg`, cantos de 22px, 44px de altura, ícone de seta de retorno + "Voltar para onde parei". |
| **Notificações** (`#dlg-notifications`) | Popover a partir do ⋯ no computador; bottom sheet no celular. Cada item tem um ponto colorido (`--info`/`--warn`/`--error`), uma mensagem e a hora em `--muted`. Ações no fim: "Copiar diagnóstico" e "Limpar". |
| **Toasts** (`#toasts`) | Embaixo e no centro, acima do rodapé. Fundo `--fg`, texto `--bg`, cantos de 12px, no máximo 2 visíveis. Ação opcional em `--accent` (no tema claro, usar a versão clara do azul para contrastar com o fundo escuro). |
| **Erros ao abrir** (DRM, não é EPUB) | Toast de erro + item no sino. Mensagem curta e humana, como já está no README. |
| **Capa sem texto / capítulo vazio** | Centralizado na área de leitura, em `--muted`: "Esta página não tem texto para traduzir." + botão "Ir para o primeiro capítulo". |
| **Tradução indisponível** | Esqueleto substituído por uma linha em `--muted`: "Não foi possível traduzir este trecho." + botão "Tentar de novo". |
| **Confirmações** (remover livro, limpar cache) | `<dialog>` pequeno (no máximo 400px), título 17px 600, texto curto, botões "Cancelar" (texto) e ação (`--error` para ações destrutivas). |
| **Lista de idiomas** | Lista simples com ✓ `--accent` no idioma selecionado. Dentro do bottom sheet no celular; `<select>` estilizado no computador é aceitável. |

---

## 5. Comportamentos que não podem mudar

- Atalhos: `←` `→` capítulo, `m` parei aqui, `b` salvar trecho, `Esc` fecha
  qualquer camada aberta (seleção, dicionário, painéis).
- Clicar numa palavra abre o dicionário; arrastar para selecionar **não** abre.
- O texto do botão "Parei aqui" sempre diz o que o próximo clique faz.
- O modo "Lado a lado" escolhido no computador volta ao retornar à tela grande.
- A formatação interna do EPUB continua ignorada (fonte, tamanho e tema vêm das
  preferências).
- `skip-link`, `aria-label` em botões só com ícone, foco visível
  (`outline: 2px solid var(--accent); outline-offset: 2px`), contraste de pelo
  menos 4.5:1 e `prefers-reduced-motion`.

---

## 6. Ordem sugerida de implementação

1. Tokens (cores, fontes, espaçamentos) em `styles.css`, sem mexer na estrutura.
   Conferir os dois temas.
2. Topo: botão Aa, menu ⋯, linha de progresso da tradução e esqueletos.
3. Área de leitura: grid por parágrafo e cabeçalhos das colunas.
4. Barra de seleção + botão compacto de "parei aqui" no rodapé. Remover os
   botões grandes.
5. Painel Aparência (popover/bottom sheet) substituindo `#dlg-settings`.
6. Dicionário (popover/bottom sheet).
7. Biblioteca (Continuar lendo, grade, capas tipográficas, estado vazio).
8. Telas da seção 4.
9. Revisão: roteiro de testes de `docs/ARQUITETURA.md` + checagem em 390px,
   768px, 1024px e 1440px, nos temas claro e escuro.

Cada etapa deve deixar o app funcionando, para poder ser feita num commit separado.
