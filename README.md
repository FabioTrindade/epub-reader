# 📖 EPUB Reader — leitura bilíngue

Leitor de EPUB que roda inteiramente no navegador, com tradução parágrafo a
parágrafo ao lado do original e dicionário ao clicar numa palavra. Sem backend,
sem build, sem cadastro: o livro nunca sai da sua máquina.

## Como rodar

```bash
cd epub-reader
python3 -m http.server 8000
# abra http://localhost:8000
```

Precisa mesmo de um servidor — abrir o `index.html` direto pelo `file://` não
funciona, porque os módulos ES não carregam nesse protocolo e o `crypto.subtle`
(usado para identificar o livro) fica indisponível fora de contexto seguro. Se
isso acontecer, o app avisa no sino em vez de falhar em silêncio.

Qualquer servidor estático serve: `npx serve`, `php -S localhost:8000`, etc.

## Como traduzir

A tradução é **automática**: os três botões no canto superior direito
(`Original` · `Lado a lado` · `Traduzido`) definem o modo, e sempre que você
abre um capítulo em `Lado a lado` ou `Traduzido` ele é traduzido sozinho. O modo
padrão é `Lado a lado`.

Duas coisas que podem parecer "nada aconteceu":

- **A primeira página costuma ser a capa**, que só tem imagem e nenhum parágrafo
  para traduzir. Escolha um capítulo no sumário à esquerda.
- **Capítulo já traduzido aparece instantaneamente**, sem barra de progresso,
  porque vem do cache local. A barra só aparece quando há trabalho de rede.

O modo escolhido fica salvo. Para ler só em inglês, use `Original` — aí nenhuma
requisição de tradução é feita.

## Funcionalidades

| Recurso | Detalhe |
|---|---|
| **EPUB 2 e 3** | `nav.xhtml` com fallback para `toc.ncx` |
| **Tradução bilíngue** | Original / Traduzido / Lado a lado, alinhado por parágrafo |
| **Dicionário** | Clique numa palavra: tradução + classe gramatical + sentidos |
| **Biblioteca** | Livros ficam no IndexedDB; reabrem sem novo upload |
| **Progresso** | Percentual de leitura por volume de texto, com barra na capa |
| **Parei aqui** | Um por livro: colore a linha onde você parou; o livro reabre nela |
| **Trechos salvos** | Vários: fita discreta na margem e lista na lateral |
| **Preferências** | Fonte, tamanho, entrelinha, tema, cor do marcador |
| **Diagnóstico** | Sino com todos os avisos e erros do app |

Atalhos: `←` / `→` navegam entre capítulos, `m` marca onde você parou, `b` salva
o trecho, `Esc` fecha diálogos e o dicionário.

## Percentual de leitura

A biblioteca mostra quanto de cada livro você já leu: uma barra fina na base da
capa (para varrer o grid de relance) e, abaixo do título, o capítulo à esquerda
e o percentual à direita — onde estou e quanto já li, na mesma linha. Livro
terminado fica verde; livro nunca aberto diz "Não iniciado".

O cálculo é por **volume de texto**, não por contagem de capítulos. Contar
capítulos mentiria: nos livros de teste eles variam de 7 a ~45.000 caracteres,
então "capítulo 74 de 147" não é metade de *Moby Dick*. Cada capítulo é medido
uma vez, na importação — custa ~0,4s porque os 147 capítulos moram em apenas 28
arquivos e a medição usa `Range.toString()`, sem clonar nós.

Capítulos anteriores contam inteiros; o atual entra proporcional à rolagem.
Livros importados antes dessa medição existir mostram um `~` (percentual
aproximado por capítulo) até serem abertos uma vez.

## Duas marcas diferentes

São coisas distintas, com sinais visuais deliberadamente diferentes:

| | **Parei aqui** | **Salvar trecho** |
|---|---|---|
| Quantidade | Uma por livro (se move) | Várias |
| No texto | Texto colorido + barra sólida | Só uma fita pontilhada na margem |
| Onde aparece | Botão flutuante para voltar | Aba "Trechos salvos" na lateral |
| Atalho | `m` | `b` |

Ambas são ancoradas no parágrafo, não na rolagem. Salvar o mesmo parágrafo duas
vezes não cria duplicata — o app avisa que já estava salvo.

## Marcador de linha ("parei aqui")

Para quando você para no meio da página. É **um por livro** e se move sempre que
você marca outro ponto.

- **Marcar**: **selecione a palavra ou frase** onde parou e clique em "Parei
  aqui" (ou tecla `m`). O trecho selecionado fica destacado como marca-texto.
- **Sem selecionar nada**, marca o parágrafo inteiro do topo da tela — útil ao
  voltar ao livro sem querer mirar numa frase.
- Também dá para clicar na alça `▸` que aparece na margem ao passar o mouse
  sobre um parágrafo, que marca o parágrafo inteiro.
- **Remover**: com o marcador à vista e nada selecionado, o botão vira
  *"Remover marca"* — o rótulo sempre diz o que o próximo clique fará, para que
  um segundo clique não mova silenciosamente a marca que você acabou de fazer.
- **Voltar**: quando o marcador sai de vista, aparece o botão flutuante
  *"Voltar para onde parei"*, que atravessa capítulos se preciso.
- **Reabrir o livro** leva direto ao marcador, com prioridade sobre a rolagem
  salva.

A linha marcada muda de **cor do texto**, além do fundo e da barra na margem.
A cor é escolhida em Configurações — âmbar, verde, azul, rosa ou roxo — com
amostra ao vivo. Cada cor tem um valor próprio para o tema claro e outro para o
escuro, todos acima de 4,5:1 de contraste (WCAG AA), já que colorir um parágrafo
inteiro prejudicaria a leitura se derivássemos os tons automaticamente.

Marcar funciona em **qualquer um dos três modos** — o marcador guarda em qual
coluna você selecionou (original ou tradução) e reaparece nela. Se essa coluna
estiver escondida no modo atual, ele recai no destaque do parágrafo, para nunca
sumir da tela.

O marcador é ancorado no **hash do texto do parágrafo** mais os offsets da
seleção dentro dele, não na altura da rolagem. Por isso ele continua na mesma frase depois de mudar o tamanho da
fonte, a largura da janela ou o modo de leitura — o que a posição de rolagem não
garante. O índice do bloco fica guardado junto, como desempate para quando a
mesma frase se repete no capítulo.

## Arquitetura

```
index.html            UI completa
css/styles.css        tokens de tema, responsivo, dark mode
js/
  main.js             entry point: liga os módulos ao DOM
  epub-parser.js      zip → capítulos (recorte por fragmento)
  renderer.js         sanitiza XHTML, resolve imagens e links
  translator.js       cache, chunking, retry, fallback
  providers/          google-gtx.js (padrão) · mymemory.js (fallback)
  dictionary.js       clique-na-palavra + popup
  reader.js           capítulo atual, navegação, progresso
  storage.js          localStorage: prefs, progresso, marcadores, "parei aqui"
  text-range.js       seleção ↔ offsets de texto estáveis
  db.js               IndexedDB: livros, traduções, palavras
  notifications.js    central de diagnóstico
lib/jszip.min.js      única dependência externa
```

### Decisões que valem saber

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
primeira entrada herda da seguinte. O contador do rodapé e o "Capítulo X de N"
da biblioteca contam pela lateral. Sem sumário utilizável, cada arquivo do
spine continua sendo um item.

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

## Tradução: provedores

O padrão é o endpoint `client=gtx` do Google Tradutor — sem chave, com CORS
liberado, e o mesmo endpoint entrega o verbete do dicionário. **É um endpoint
não-oficial**: pode mudar ou passar a limitar sem aviso. É a dependência mais
frágil do projeto, mitigada por cache agressivo, batching, throttle e queda
automática para o MyMemory.

O LibreTranslate não é mais viável como padrão: as instâncias públicas passaram
a exigir API key (`libretranslate.de` hoje redireciona para
`de.libretranslate.com`, e ambos respondem pedindo chave). Para usá-lo, crie
`js/providers/libretranslate.js` seguindo a mesma interface
(`translateBatch`, `lookupWord`, `maxChunkChars`) e registre em `PROVIDERS`, no
topo de `js/translator.js`.

## Sino de diagnóstico

Em vez de `console.warn`, todo evento vai para a central de notificações. Eventos
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

## Limitações

- EPUBs com DRM não abrem (são zips cifrados) — o app avisa em vez de falhar.
- O CSS do próprio livro é descartado de propósito: é a principal causa de texto
  ilegível no dark mode. A tipografia vem das suas preferências.
- Livros muito grandes podem travar a UI durante o parse; mover o JSZip para um
  Web Worker resolveria.

## Testes

Validado ponta a ponta no Chrome com dois livros do Project Gutenberg:
*Moby Dick* (EPUB 2, `toc.ncx`, 147 capítulos) e *Pride and Prejudice* (EPUB 3,
`nav.xhtml`, 65 capítulos, com imagens). Cobertura: parsing dos dois formatos,
capa e imagens como blob, tradução completa com verificação de alinhamento,
cache (zero requests ao revisitar), dicionário, persistência entre recargas,
fallback de provider com os dois endpoints bloqueados, coalescing do sino,
responsivo a 390px e os três temas.
