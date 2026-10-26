/**
 * Dicionário: clicar numa palavra abre o verbete.
 *
 * A palavra é localizada pelas APIs de caret e o trecho é expandido até as
 * bordas. A alternativa — envolver cada palavra num <span> — geraria dezenas de
 * milhares de nós por capítulo e deixaria a renderização lenta.
 */

/** Letras, marcas de acentuação, apóstrofos e hífen interno. */
const WORD_CHAR = /[\p{L}\p{M}'’\-]/u;
const EDGE_TRIM = /^[-'’]+|[-'’]+$/g;

function caretRangeFromPoint(x, y) {
  if (document.caretRangeFromPoint) {
    return document.caretRangeFromPoint(x, y); // WebKit / Blink
  }
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y); // Firefox
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  }
  return null;
}

/** Expande um ponto no texto até os limites da palavra. */
function wordRangeAt(x, y) {
  const caret = caretRangeFromPoint(x, y);
  if (!caret) return null;

  const node = caret.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.data;
  let start = caret.startOffset;
  let end = start;

  // Clique logo após a palavra ainda deve pegá-la.
  if (start > 0 && !WORD_CHAR.test(text[start] || '') && WORD_CHAR.test(text[start - 1])) {
    start -= 1;
    end = start;
  }
  if (!WORD_CHAR.test(text[start] || '')) return null;

  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
  while (end < text.length && WORD_CHAR.test(text[end])) end++;

  const raw = text.slice(start, end);
  const word = raw.replace(EDGE_TRIM, '');
  if (!word || word.length > 40) return null;

  const range = document.createRange();
  range.setStart(node, start + raw.indexOf(word));
  range.setEnd(node, start + raw.indexOf(word) + word.length);
  return { word, range };
}

export class DictionaryPopup {
  #el = null;
  #highlight = null;
  #token = 0;

  constructor(translator) {
    this.translator = translator;

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.close();
    });
    document.addEventListener('pointerdown', (ev) => {
      if (this.#el && !this.#el.contains(ev.target)) this.close();
    });
    window.addEventListener('resize', () => this.close());
  }

  /** Liga o dicionário a um container de capítulo. */
  attach(container) {
    container.addEventListener('click', (ev) => {
      // Links têm navegação própria; não roubamos o clique deles.
      if (ev.target.closest('a')) return;

      // Arrastar para selecionar termina com um click: abrir o dicionário aqui
      // atropelaria a seleção que o usuário acabou de fazer.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;

      const hit = wordRangeAt(ev.clientX, ev.clientY);
      if (!hit) return;

      ev.preventDefault();
      this.show(hit);
    });
  }

  async show({ word, range }) {
    this.close();

    const token = ++this.#token;
    this.#markWord(range);

    const rect = range.getBoundingClientRect();
    this.#el = this.#build(word);
    document.body.append(this.#el);
    this.#position(rect);

    try {
      const entry = await this.translator.lookupWord(word);
      if (token !== this.#token) return; // outra palavra foi clicada enquanto carregava
      this.#renderEntry(entry);
    } catch (err) {
      if (token !== this.#token) return;
      this.#renderError(err);
    }
    this.#position(rect);
  }

  #markWord(range) {
    const mark = document.createElement('mark');
    mark.className = 'dict-highlight';
    try {
      range.surroundContents(mark);
      this.#highlight = mark;
    } catch {
      // Seleção atravessa elementos: seguimos sem destaque.
      this.#highlight = null;
    }
  }

  #build(word) {
    const el = document.createElement('div');
    el.className = 'dict-popup';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `Dicionário: ${word}`);
    el.innerHTML = `
      <div class="dict-head">
        <strong class="dict-word"></strong>
        <button class="dict-close" aria-label="Fechar">&times;</button>
      </div>
      <div class="dict-body"><div class="dict-loading">Buscando…</div></div>`;
    el.querySelector('.dict-word').textContent = word;
    el.querySelector('.dict-close').addEventListener('click', () => this.close());
    return el;
  }

  #renderEntry(entry) {
    const body = this.#el.querySelector('.dict-body');
    body.textContent = '';

    const main = document.createElement('p');
    main.className = 'dict-translation';
    main.textContent = entry.translation || '—';
    body.append(main);

    for (const group of entry.entries || []) {
      if (!group.terms?.length) continue;
      const row = document.createElement('div');
      row.className = 'dict-group';

      const pos = document.createElement('span');
      pos.className = 'dict-pos';
      pos.textContent = group.pos || '';

      const terms = document.createElement('span');
      terms.className = 'dict-terms';
      terms.textContent = group.terms.join(', ');

      row.append(pos, terms);
      body.append(row);
    }

    if (!entry.entries?.length) {
      const note = document.createElement('p');
      note.className = 'dict-note';
      note.textContent = 'Sem verbete detalhado para esta palavra.';
      body.append(note);
    }
  }

  #renderError(err) {
    const body = this.#el.querySelector('.dict-body');
    body.textContent = '';
    const p = document.createElement('p');
    p.className = 'dict-error';
    p.textContent = navigator.onLine
      ? `Não foi possível buscar: ${err.message}`
      : 'Sem conexão — o dicionário precisa de internet.';
    body.append(p);
  }

  /** Abre abaixo da palavra; se não couber, acima. Sempre dentro da viewport. */
  #position(rect) {
    const el = this.#el;
    if (!el) return;

    const margin = 8;
    const { width, height } = el.getBoundingClientRect();

    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

    let top = rect.bottom + margin;
    if (top + height > window.innerHeight - margin) {
      top = rect.top - height - margin;
    }
    top = Math.max(margin, top);

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  close() {
    this.#token++;
    this.#el?.remove();
    this.#el = null;

    if (this.#highlight) {
      // Desfaz o <mark> e reconstitui o nó de texto.
      const parent = this.#highlight.parentNode;
      this.#highlight.replaceWith(...this.#highlight.childNodes);
      parent?.normalize();
      this.#highlight = null;
    }
  }
}
