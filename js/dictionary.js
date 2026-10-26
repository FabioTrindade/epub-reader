/**
 * Dicionário: clicar numa palavra abre o verbete.
 *
 * A palavra é localizada pelas APIs de caret e o trecho é expandido até as
 * bordas. A alternativa — envolver cada palavra num <span> — geraria dezenas de
 * milhares de nós por capítulo e deixaria a renderização lenta.
 */

import { enableSheetDrag } from './ui.js';

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

const MOBILE = window.matchMedia('(max-width: 768px)');
const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/**
 * Verbete da palavra clicada: popover junto da palavra no computador, painel
 * que sobe do rodapé no celular (onde um popover cobriria o próprio texto).
 */
export class DictionaryPopup {
  #el = null;
  #scrim = null;
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
      // Links têm navegação própria; não roubamos o clique deles. Cabeçalho
      // das colunas e avisos são textos do app, não do livro.
      if (ev.target.closest('a, button, .columns-head, .tr-unavailable, .chapter-empty')) return;

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
    const sheet = MOBILE.matches;
    this.#el = this.#build(word, sheet);
    if (sheet) {
      this.#scrim = document.createElement('div');
      this.#scrim.className = 'dict-scrim';
      document.body.append(this.#scrim);
    }
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

  #build(word, sheet) {
    const el = document.createElement('div');
    el.className = sheet ? 'dict-popup is-sheet' : 'dict-popup';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `Dicionário: ${word}`);
    el.innerHTML = `
      <span class="sheet-handle" aria-hidden="true"></span>
      <div class="dict-head">
        <div class="dict-title">
          <strong class="dict-word"></strong>
          <span class="dict-translation"></span>
        </div>
        <span class="dict-hint">Esc para fechar</span>
        <button class="dict-close" aria-label="Fechar dicionário">${CLOSE_ICON}</button>
      </div>
      <div class="dict-body"><p class="dict-loading">Buscando…</p></div>`;
    el.querySelector('.dict-word').textContent = word;
    el.querySelector('.dict-close').addEventListener('click', () => this.close());
    if (sheet) enableSheetDrag(el, () => this.close());
    return el;
  }

  #renderEntry(entry) {
    this.#el.querySelector('.dict-translation').textContent = entry.translation || '—';

    const body = this.#el.querySelector('.dict-body');
    body.textContent = '';

    for (const group of entry.entries || []) {
      if (!group.terms?.length) continue;
      const row = document.createElement('div');
      row.className = 'dict-group';

      const pos = document.createElement('span');
      pos.className = 'dict-pos';
      pos.textContent = group.pos || '';

      // Um <span> por sentido: no computador o CSS junta com vírgulas, no
      // celular cada um vira um chip.
      const terms = document.createElement('div');
      terms.className = 'dict-terms';
      for (const term of group.terms) {
        const chip = document.createElement('span');
        chip.textContent = term;
        terms.append(chip);
      }

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
    if (!el || el.classList.contains('is-sheet')) return;

    const margin = 8;
    const { width, height } = el.getBoundingClientRect();

    let left = rect.left - 24;
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
    this.#scrim?.remove();
    this.#scrim = null;

    if (this.#highlight) {
      // Desfaz o <mark> e reconstitui o nó de texto.
      const parent = this.#highlight.parentNode;
      this.#highlight.replaceWith(...this.#highlight.childNodes);
      parent?.normalize();
      this.#highlight = null;
    }
  }
}
