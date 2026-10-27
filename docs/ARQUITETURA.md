# Arquitetura e decisões técnicas

Este documento é para quem vai ler ou modificar o código. Para usar o app, veja o
[README](../README.md).

O projeto é HTML, CSS e JavaScript puros, com módulos ES nativos: sem build, sem
framework e sem `npm install`. A única dependência é o JSZip, vendorizado em
`lib/`. O visual segue [DESIGN.md](DESIGN.md), que é a fonte da verdade para
tokens, componentes e telas.

## Estrutura

```
index.html            UI completa
css/styles.css        fontes, tokens de tema, responsivo, dark mode
fonts/                Literata e Inter (woff2, licença OFL)
js/
  main.js             entry point: liga os módulos ao DOM
  epub-parser.js      zip → capítulos (recorte por fragmento)
  renderer.js         sanitiza XHTML, resolve imagens e links
  translator.js       cache, chunking, retry, fallback
  providers/          google-gtx.js (padrão) · mymemory.js (fallback)
  dictionary.js       clique-na-palavra: popover ou painel no celular
  ui.js               menus, painéis, biblioteca, aparência, notificações
  reader.js           capítulo atual, navegação, progresso
  storage.js          localStorage: prefs, progresso, marcadores, "parei aqui"
  text-range.js       seleção ↔ offsets de texto estáveis
  db.js               IndexedDB: livros, traduções, palavras
  notifications.js    central de diagnóstico
lib/jszip.min.js      única dependência externa
```

## Publicação no GitHub Pages

O site oficial, <https://fabiotrindade.github.io/epub-reader/>, é servido pelo
GitHub Pages a partir da branch `main`, pasta raiz (**Settings → Pages →
Deploy from a branch → `main` / `(root)`**). Como tudo são arquivos estáticos,
publicar é fazer push na `main`: o Pages republica sozinho em alguns minutos.
O Pages serve por HTTPS, que é o contexto seguro de que o app precisa (veja
abaixo).

Três cuidados:

- O app fica num subcaminho (`/epub-reader/`), então todo caminho no HTML, no
  CSS e no JS é relativo (`css/styles.css`, `./db.js`, `../fonts/…`). Um
  caminho absoluto (`/css/…`) funcionaria no `localhost` e quebraria no Pages.
- O servidor do Pages diferencia maiúsculas de minúsculas, ao contrário do
  macOS: o nome usado no código precisa bater exatamente com o do arquivo.
- O Pages manda os arquivos com cache de cerca de 10 minutos. Logo depois de
  publicar, recarregue com `Cmd+Shift+R` (ou `Ctrl+Shift+R`) para ver a
  versão nova.

**Sua própria cópia:** faça um fork do repositório e ative o Pages no fork do
mesmo jeito. Ela fica em `https://<seu-usuario>.github.io/epub-reader/`. Os
dados de cada leitor ficam no navegador dele, separados por endereço: uma
cópia não enxerga a biblioteca da outra.

## Rodando localmente

Para desenvolver, sirva a pasta com qualquer servidor estático:

```bash
python3 -m http.server 8000
# abra http://localhost:8000
```

Precisa mesmo de um servidor — abrir o `index.html` direto pelo `file://` não
funciona, porque os módulos ES não carregam nesse protocolo e o `crypto.subtle`
(usado para identificar o livro) fica indisponível fora de contexto seguro. Se
isso acontecer, o app avisa em Notificações (menu ⋯) em vez de falhar em
silêncio.

Qualquer servidor estático serve: `npx serve`, `php -S localhost:8000`, etc.

O servidor do Python não manda cabeçalhos de cache, então depois de mudar um
arquivo JS o navegador pode continuar usando a versão antiga: recarregue com
`Cmd+Shift+R` (ou `Ctrl+Shift+R`).

## Decisões que valem saber

**O capítulo é a entrada do sumário, não o item do spine.** EPUBs reais fatiam o
livro em arquivos arbitrários: *Pride and Prejudice* tem 63 entradas de sumário
em apenas 9 arquivos, e *Moby Dick* tem 146 em 28. Tratar spine como capítulo
entregaria blocos gigantes. Cada capítulo guarda `{ docPath, fragment }` e o
conteúdo é recortado com `Range`, que reconstrói a árvore corretamente mesmo
quando as âncoras estão em profundidades diferentes.

**Arquivo fora do sumário não ganha item na lateral.** O Calibre fatia capítulos
longos (`part0011_split_000`, `_001`, `_002`…) e o sumário só aponta para o
primeiro pedaço; *Team Topologies* tem 16 arquivos assim em 44. Cada pedaço
continua sendo um capítulo interno — as setas passam por ele e progresso,
marcadores e "parei aqui" guardam as mesmas posições —, mas herda o título da
entrada anterior e acende ela na lateral. A capa embrulhada num xhtml antes da
primeira entrada herda da seguinte. O rodapé e a biblioteca mostram o título
dessa entrada, nunca uma contagem: "Capítulo 12 de 29" contaria entradas do
sumário (capa, prefácio, partes) e contradiria a numeração do livro. Sem
sumário utilizável, cada arquivo do spine continua sendo um item.

**Tradução em lote com re-alinhamento.** Um request por parágrafo seria lento
demais; o capítulo inteiro de uma vez perderia a correspondência. O meio-termo
aproveita duas propriedades do endpoint: o `\n` sobrevive à tradução, e o array
`sentences` divide por frase (não por parágrafo). Então juntamos parágrafos com
`\n` até ~4000 caracteres, mandamos um request, concatenamos as frases e damos
`split('\n')` para reparear 1:1. **Se a contagem não bater, o chunk é descartado
e re-traduzido um parágrafo por vez** — sem essa guarda, um desalinhamento
silencioso embaralharia o livro inteiro.

**Imagens são neutralizadas antes de tocar o DOM.** O `src` vira `data-epub-src`
logo após o parse. Sem isso, clonar o fragmento faz o navegador disparar um GET
relativo à URL do app, que responde 404 — o arquivo mora dentro do zip.

**O bloco vira a linha do grid.** Para o modo lado a lado, o conteúdo de cada
bloco vai para `.tr-orig` e ganha um irmão `.tr-trans`, mas o elemento original
permanece no lugar. Envolvê-lo num `<div>` externo quebraria `<li>` dentro de
`<ul>` e `<td>` dentro de `<tr>`.

**Divisão de armazenamento.** localStorage só guarda o pequeno e síncrono
(preferências, progresso, marcadores). Livro e cache de tradução vão para o
IndexedDB: localStorage tem ~5MB e bloqueia a thread principal.

**Bloco sem letras não ganha coluna de tradução.** Número de capítulo numa
tabela de layout (Team Topologies), número de página na lista de ilustrações
(Pride and Prejudice), "* * * * * *" (Moby Dick): repetir na tradução só
duplicava, e uma célula de tabela virando grade desmontava a tabela. O bloco
continua sendo `.tr-row` (com a classe `.tr-plain`), porque o índice dos
blocos ancora marcas e trechos salvos; só não tem `.tr-trans` nem vai ao
tradutor, e mantém o display de origem (`revert`).

**Blockquotes aninhados contam como um só.** O Calibre faz recuo aninhando
blockquotes (dez níveis numa assinatura de epígrafe); como o CSS do livro é
descartado, só o de fora desenha a barra e o recuo.

**O CSS do próprio livro é descartado de propósito.** É a principal causa de
texto ilegível no dark mode. A tipografia vem das preferências do leitor.

**As fontes são servidas pelo próprio app.** Literata (texto) e Inter
(interface) ficam em `fonts/`, nos subconjuntos latin e latin-ext, com
`unicode-range` para o segundo só baixar quando preciso. Carregá-las do Google
Fonts mandaria um pedido a terceiros a cada visita, o que contradiria a seção
de privacidade do README.

**Falha de tradução não vai para o cache.** Um parágrafo que falha volta como
`null` e não é gravado; entradas sem texto já gravadas são ignoradas na
leitura. Senão o capítulo pareceria todo em cache e aqueles parágrafos nunca
mais seriam tentados. O aviso "Não foi possível traduzir este trecho" só
aparece na pintura final, quando não vem mais nada para o capítulo.

**No celular, a vista vem da aba, não da preferência.** O `Reader` reaplica a
cada capítulo o último modo que recebeu por `applyViewMode`; no celular é a
aba Original/Tradução, já que "Lado a lado" não cabe ali.

## Percentual de leitura

O cálculo é por **volume de texto**, não por contagem de capítulos. Contar
capítulos mentiria: nos livros de teste eles variam de 7 a ~45.000 caracteres,
então "capítulo 74 de 147" não é metade de *Moby Dick*. Cada capítulo é medido
uma vez, na importação — custa ~0,4s porque os 147 capítulos moram em apenas 28
arquivos e a medição usa `Range.toString()`, sem clonar nós.

Capítulos anteriores contam inteiros; o atual entra proporcional à rolagem.
Livros importados antes dessa medição existir mostram um `~` (percentual
aproximado por capítulo) até serem abertos uma vez.

## Âncora do "parei aqui"

O marcador é ancorado no **hash do texto do parágrafo** mais os offsets da
seleção dentro dele, não na altura da rolagem. Por isso ele continua na mesma
frase depois de mudar o tamanho da fonte, a largura da janela ou o modo de
leitura — o que a posição de rolagem não garante. O índice do bloco fica
guardado junto, como desempate para quando a mesma frase se repete no capítulo.

O marcador também guarda em qual coluna a seleção foi feita (original ou
tradução). Se essa coluna estiver escondida no modo atual, ele recai no destaque
do parágrafo, para nunca sumir da tela.

Cada cor do marcador tem um valor próprio para o tema claro e outro para o
escuro, todos acima de 4,5:1 de contraste (WCAG AA), já que colorir um parágrafo
inteiro prejudicaria a leitura se derivássemos os tons automaticamente.

## Tradução: provedores

O padrão é o endpoint `client=gtx` do Google Tradutor — sem chave, com CORS
liberado, e o mesmo endpoint entrega o verbete do dicionário. **É um endpoint
não-oficial**: pode mudar ou passar a limitar sem aviso. É a dependência mais
frágil do projeto, mitigada por cache agressivo, batching, throttle e queda
automática para o MyMemory.

As requisições saem do navegador de cada leitor, não de um servidor do projeto.
Por isso não há custo de backend, e os limites de uso são contados por IP de cada
leitor.

O LibreTranslate não é mais viável como padrão: as instâncias públicas passaram
a exigir API key (`libretranslate.de` hoje redireciona para
`de.libretranslate.com`, e ambos respondem pedindo chave). Para usá-lo, crie
`js/providers/libretranslate.js` seguindo a mesma interface
(`translateBatch`, `lookupWord`, `maxChunkChars`) e registre em `PROVIDERS`, no
topo de `js/translator.js`.

## Notificações e diagnóstico

Em vez de `console.warn`, todo evento vai para a central de notificações (menu
⋯ → Notificações; um ponto sobre o ⋯ avisa quando há aviso ou erro). Eventos
do mesmo tipo são **coalescidos** (`×3`), para que um capítulo com muitas falhas
gere uma linha e não quarenta. Só `warn` e `error` também disparam toast. O botão
"copiar diagnóstico" gera um relatório com navegador, versão e histórico.

| `code` | Quando aparece |
|---|---|
| `drm-detected` | EPUB cifrado, impossível de abrir |
| `toc-missing` | Sem `nav.xhtml` nem `toc.ncx` |
| `chapter-missing` / `asset-missing` | Arquivo referenciado não existe no zip |
| `content-sanitized` | Script ou handler inline removido |
| `translate-misaligned` | Guarda de alinhamento disparou; modo lento |
| `translate-ratelimited` | HTTP 429; em backoff |
| `provider-fallback` | Trocou de Google para MyMemory |
| `translate-failed` | Desistiu após as tentativas |
| `offline` | Sem internet ao traduzir |
| `quota-exceeded` | IndexedDB sem espaço |
| `insecure-context` | Rodando fora de contexto seguro |

## Limitações técnicas

- EPUBs com DRM não abrem (são zips cifrados) — o app avisa em vez de falhar.
- Livros muito grandes podem travar a UI durante o parse; mover o JSZip para um
  Web Worker resolveria.

## Testes

Validado ponta a ponta no Chrome com dois livros do Project Gutenberg:
*Moby Dick* (EPUB 2, `toc.ncx`, 147 capítulos) e *Pride and Prejudice* (EPUB 3,
`nav.xhtml`, 65 capítulos, com imagens). Cobertura: parsing dos dois formatos,
capa e imagens como blob, tradução completa com verificação de alinhamento,
cache (zero requests ao revisitar), dicionário, persistência entre recargas,
fallback de provider com os dois endpoints bloqueados, coalescing das
notificações, responsivo a 390px e os três temas.

O redesign foi validado também com o Chrome headless dirigido por CDP: o mesmo
roteiro na versão anterior e na nova (sumário, navegação por setas, "parei
aqui" por seleção, trecho salvo, reabertura na marca) deu resultado idêntico, e
a tradução indisponível foi testada bloqueando os dois serviços com
`Network.setBlockedURLs`.

Os EPUBs de teste ficam em `test-books/`, que está no `.gitignore`. Para
reproduzir, baixe do Project Gutenberg e salve com estes nomes:

| Arquivo | Origem |
|---|---|
| `test-books/moby-epub2.epub` | [gutenberg.org/ebooks/2701](https://www.gutenberg.org/ebooks/2701), formato EPUB para leitores antigos (EPUB 2) |
| `test-books/pride-epub3.epub` | [gutenberg.org/ebooks/1342](https://www.gutenberg.org/ebooks/1342), formato EPUB3 com imagens |

Mudanças no parser ou na navegação devem ser comparadas com a versão anterior
nesses dois livros: eles já funcionam e não podem mudar de comportamento sem
intenção.
