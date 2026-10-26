/**
 * Conversão entre uma seleção do usuário e offsets estáveis de texto.
 *
 * Guardar nó + offset do DOM não serve: o capítulo é reconstruído a cada
 * abertura, e a tradução reescreve a coluna traduzida. Offsets contados sobre o
 * texto puro do bloco sobrevivem a isso — e também a mudança de fonte, largura
 * e modo de leitura, porque não dependem de layout.
 */

/** Posição de (nó, offset) contada em caracteres do texto puro de `root`. */
export function offsetOf(root, node, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current;
  while ((current = walker.nextNode())) {
    if (current === node) return total + offset;
    total += current.data.length;
  }
  return total;
}

/** Caminho inverso: offsets de texto puro → Range no DOM atual. */
export function rangeFromOffsets(root, start, end) {
  if (start >= end) return null;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let total = 0;
  let started = false;
  let current;

  while ((current = walker.nextNode())) {
    const len = current.data.length;

    if (!started && total + len > start) {
      range.setStart(current, start - total);
      started = true;
    }
    if (started && total + len >= end) {
      range.setEnd(current, end - total);
      return range;
    }
    total += len;
  }

  return null;
}

/**
 * Envolve o range num elemento.
 *
 * surroundContents falha quando a seleção atravessa a borda de um elemento
 * (metade de um <em>, por exemplo) — caso comum ao selecionar uma frase.
 * extractContents + insertNode reconstrói os ancestrais parciais e funciona
 * nos dois casos.
 */
export function wrapRange(range, el) {
  el.append(range.extractContents());
  range.insertNode(el);
  return el;
}

/** Desfaz o wrap, devolvendo o texto ao fluxo original. */
export function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  el.replaceWith(...el.childNodes);
  parent.normalize();
}

/**
 * Lê a seleção atual, se ela estiver dentro de `container`.
 * @returns {{side: Element, start: number, end: number, text: string} | null}
 */
export function readSelection(container) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;

  const range = selection.getRangeAt(0);
  const text = range.toString().trim();
  if (!text) return null;

  // A seleção precisa começar e terminar dentro do mesmo lado (original ou
  // tradução) — senão não há um texto de referência único para ancorar.
  const startSide = sideOf(range.startContainer, container);
  const endSide = sideOf(range.endContainer, container);
  if (!startSide || startSide !== endSide) return null;

  return {
    side: startSide,
    start: offsetOf(startSide, range.startContainer, range.startOffset),
    end: offsetOf(startSide, range.endContainer, range.endOffset),
    text,
  };
}

function sideOf(node, container) {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!el || !container.contains(el)) return null;
  return el.closest('.tr-orig, .tr-trans');
}
