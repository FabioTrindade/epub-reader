/**
 * Estado de leitura: capítulo atual, navegação, tradução e progresso.
 *
 * Estrutura bilíngue: o próprio elemento de bloco vira a linha do grid, com
 * .tr-orig e .tr-trans como filhos. Envolver o bloco num <div> externo quebraria
 * <li> dentro de <ul> e <td> dentro de <tr>; mantendo o elemento no lugar, a
 * semântica da lista/tabela sobrevive.
 */

import { getChapterContent, deriveTitle, clearDocCache } from './epub-parser.js';
import { ChapterRenderer, collectBlocks } from './renderer.js';
import { Translator, hashText, normalize } from './translator.js';
import { DictionaryPopup } from './dictionary.js';
import { readSelection, rangeFromOffsets, wrapRange, unwrap } from './text-range.js';
import * as storage from './storage.js';
import * as db from './db.js';

/** "en" → "Inglês", "pt-BR" → "Português (Brasil)", para os cabeçalhos das colunas. */
function languageName(code) {
  try {
    const name = new Intl.DisplayNames(['pt-BR'], { type: 'language' }).of(code);
    return name ? name[0].toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}

export class Reader extends EventTarget {
  #renderer = new ChapterRenderer();
  #translator = null;
  #dictionary = null;
  #abort = null;
  #saveTimer = null;
  #viewMode = null;

  constructor(viewportEl) {
    super();
    this.viewport = viewportEl;
    this.book = null;
    this.chapterIndex = -1;
    this.container = null;

    this.viewport.addEventListener('scroll', () => this.#scheduleSave(), { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.#saveProgress();
    });

    this.#setupMarkHandle();
  }

  get chapter() { return this.book?.chapters[this.chapterIndex] || null; }
  get translator() { return this.#translator; }

  async open(book, { chapterIndex = 0, scrollRatio = 0, anchor = null } = {}) {
    this.book = book;
    this.#translator = new Translator({
      bookId: book.id,
      targetLang: storage.getPrefs().targetLang,
      sourceLang: book.lang || 'auto',
    });
    this.#dictionary = new DictionaryPopup(this.#translator);

    await this.loadChapter(chapterIndex, { scrollRatio, anchor });
  }

  close() {
    this.#cancelTranslation();
    this.#renderer.releaseAll();
    this.#dictionary?.close();
    clearDocCache();
    if (this.markHandle) this.markHandle.hidden = true;
    this.viewport.textContent = '';
    this.book = null;
    this.chapterIndex = -1;
  }

  /* --------------------------------- navegação -------------------------------- */

  async loadChapter(index, { scrollRatio = 0, fragment = '', anchor = null } = {}) {
    if (!this.book) return;
    const clamped = Math.max(0, Math.min(index, this.book.chapters.length - 1));

    this.#saveProgress();
    this.#cancelTranslation();
    this.#dictionary.close();
    this.#renderer.releaseAll();

    this.chapterIndex = clamped;
    const chapter = this.book.chapters[clamped];

    this.#emit('chapter-loading', { chapter });

    const content = await getChapterContent(this.book, chapter);
    if (!content) {
      this.viewport.textContent = '';
      this.#emit('chapter-error', { chapter });
      return;
    }

    if (!chapter.title) chapter.title = deriveTitle(content, clamped);

    const container = this.#renderer.render(content, this.book, chapter.docPath, (idx, frag) =>
      this.loadChapter(idx, { fragment: frag })
    );

    this.#prepareBilingual(container);
    this.#addColumnsHead(container);
    this.#dictionary.attach(container);

    this.viewport.textContent = '';
    this.viewport.append(container);
    this.container = container;

    // A vista efetiva vem de quem chamou applyViewMode por último: no celular
    // é a aba escolhida, não a preferência salva ("split" não cabe lá).
    this.applyViewMode(this.#viewMode ?? storage.getPrefs().viewMode);

    const markEl = this.#applyMark();
    this.refreshBookmarks();

    // Restaurar posição só depois do layout, senão o scroll cai no lugar errado.
    requestAnimationFrame(() => {
      // Âncora com seleção: rolar até a frase marcada, não até o parágrafo.
      const target = anchor
        ? (anchor.start != null && markEl ? markEl : this.#findRowByAnchor(anchor))
        : null;

      if (fragment) this.#scrollToFragment(fragment);
      else if (target) target.scrollIntoView({ block: 'center' });
      else this.#restoreScroll(scrollRatio);
    });

    storage.setProgress(this.book.id, { chapterIndex: clamped, scrollRatio });
    db.touchBook(this.book.id);

    // applyViewMode acima já dispara a tradução quando o modo não é "original";
    // não chamar translate() de novo aqui, senão uma chamada aborta a outra.
    this.#emit('chapter-loaded', { chapter, index: clamped });
  }

  next() { return this.loadChapter(this.chapterIndex + 1); }
  previous() { return this.loadChapter(this.chapterIndex - 1); }

  #scrollToFragment(fragment) {
    const target = this.container?.querySelector(`[id="${CSS.escape(fragment)}"]`);
    if (target) target.scrollIntoView({ block: 'start' });
    else this.viewport.scrollTop = 0;
  }

  /* --------------------------------- bilíngue --------------------------------- */

  /** Move o conteúdo de cada bloco para .tr-orig e cria o par .tr-trans vazio. */
  #prepareBilingual(container) {
    collectBlocks(container).forEach((block, index) => {
      const orig = document.createElement('div');
      orig.className = 'tr-orig';
      while (block.firstChild) orig.append(block.firstChild);

      const trans = document.createElement('div');
      trans.className = 'tr-trans';

      block.append(orig, trans);
      block.classList.add('tr-row');
      // Âncora do bloco: serve ao cache de tradução e ao marcador de leitura.
      block.dataset.hash = hashText(normalize(orig.textContent));
      block.dataset.blockIndex = index;
    });
  }

  /** "Inglês · original" | "Português (Brasil) · tradução" — o CSS só mostra no lado a lado. */
  #addColumnsHead(container) {
    const head = document.createElement('div');
    head.className = 'columns-head';
    const orig = document.createElement('span');
    orig.textContent = `${languageName(this.book.lang || 'en')} · original`;
    const trans = document.createElement('span');
    trans.textContent = `${languageName(this.#translator.targetLang)} · tradução`;
    head.append(orig, trans);
    container.prepend(head);
  }

  applyViewMode(mode) {
    // Guardado mesmo sem capítulo aberto: o primeiro loadChapter usa este modo.
    this.#viewMode = mode;
    if (!this.container) return;
    this.container.classList.remove('mode-original', 'mode-translated', 'mode-split');
    this.container.classList.add(`mode-${mode}`);

    // A coluna onde o marcador vive pode ter acabado de ser escondida; então
    // ele precisa recair no destaque do parágrafo para não sumir da tela.
    this.#applyMark();

    if (mode !== 'original' && !this.container.dataset.translated) {
      this.translate();
    }
  }

  /** Interrompe a tradução em andamento (botão "Cancelar"). */
  cancelTranslation() { this.#cancelTranslation(); }

  #cancelTranslation() {
    if (!this.#abort) return;
    this.#abort.abort();
    this.#abort = null;
    // A barra já pode estar na tela: quem cancela é responsável por tirá-la.
    this.#emit('translate-cancelled', {});
  }

  /**
   * Traduz o capítulo visível: primeiro o que está em cache (aparece na hora),
   * depois o que falta, pela rede.
   *
   * Uma chamada só. Duas chamadas concorrentes se cancelariam mutuamente, já
   * que a segunda aborta o AbortController da primeira.
   */
  async translate() {
    if (!this.container || !this.#translator) return;

    const rows = [...this.container.querySelectorAll('.tr-row')];
    if (!rows.length) return;

    const texts = rows.map((r) => r.querySelector('.tr-orig').textContent);

    this.#cancelTranslation();
    const controller = new AbortController();
    this.#abort = controller;

    // 1. Cache: pinta imediatamente, sem barra de progresso nem rede.
    const hashes = rows.map((r) => r.dataset.hash);
    const cached = await db.getTranslations(this.book.id, this.#translator.targetLang, hashes);
    if (controller.signal.aborted) return;

    if (cached.size) this.#paint(rows, cached);

    if (cached.size === rows.length) {
      this.container.dataset.translated = '1';
      if (this.#abort === controller) this.#abort = null;
      this.#emit('translate-done', {});
      return;
    }

    // 2. O que faltou vai à rede.
    this.#translator.resetProvider();
    this.#emit('translate-start', { total: rows.length });

    try {
      const map = await this.#translator.translate(texts, {
        signal: controller.signal,
        onProgress: (done, total) => this.#emit('translate-progress', { done, total }),
      });
      if (controller.signal.aborted) return;
      this.#paint(rows, map);
      this.container.dataset.translated = '1';
      this.#emit('translate-done', {});
    } catch (err) {
      if (err.message === 'ABORTED') return;
      this.#emit('translate-error', { error: err });
    } finally {
      if (this.#abort === controller) this.#abort = null;
    }
  }

  #paint(rows, map) {
    for (const row of rows) {
      const slot = row.querySelector('.tr-trans');
      const text = map.get(row.dataset.hash);
      if (text) {
        slot.textContent = text;
        slot.classList.remove('is-empty');
      } else if (!slot.textContent) {
        slot.classList.add('is-empty');
      }
    }

    // Escrever na coluna traduzida apaga um marcador que esteja nela — e, na
    // abertura do capítulo, o marcador ainda nem pôde ser aplicado porque a
    // tradução não existia. Reaplicar aqui cobre os dois casos.
    const mark = this.book ? storage.getReadingMark(this.book.id) : null;
    if (mark && mark.chapterIndex === this.chapterIndex) this.#applyMark();
  }

  /* --------------------------------- progresso -------------------------------- */

  get scrollRatio() {
    const max = this.viewport.scrollHeight - this.viewport.clientHeight;
    return max > 0 ? this.viewport.scrollTop / max : 0;
  }

  #restoreScroll(ratio) {
    if (!ratio) { this.viewport.scrollTop = 0; return; }
    const max = this.viewport.scrollHeight - this.viewport.clientHeight;
    this.viewport.scrollTop = max * ratio;
  }

  #scheduleSave() {
    this.#emit('scroll', { ratio: this.scrollRatio });
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#saveProgress(), 500);
  }

  #saveProgress() {
    if (!this.book || this.chapterIndex < 0) return;
    storage.setProgress(this.book.id, {
      chapterIndex: this.chapterIndex,
      scrollRatio: this.scrollRatio,
    });
  }

  /** Primeiro bloco visível no topo da área de leitura. */
  topVisibleRow() {
    const top = this.viewport.getBoundingClientRect().top;
    for (const row of this.container?.querySelectorAll('.tr-row') || []) {
      if (row.getBoundingClientRect().bottom > top + 4) return row;
    }
    return null;
  }

  /** Texto do primeiro bloco visível — usado como rótulo do bookmark. */
  currentExcerpt() {
    const row = this.topVisibleRow();
    return row ? row.querySelector('.tr-orig').textContent.trim().slice(0, 120) : '';
  }

  /* ----------------------------- marcador de linha ---------------------------- */

  /**
   * "Parei aqui".
   *
   * Se houver texto selecionado, marca exatamente a seleção — é o gesto
   * natural: seleciono a frase onde parei e marco. Sem seleção, marca o
   * parágrafo inteiro no topo da tela (o caso da tecla M ao voltar ao livro).
   */
  mark() {
    if (!this.book || !this.container) return null;

    const selection = readSelection(this.container);
    return selection ? this.#markSelection(selection) : this.markRow(this.topVisibleRow());
  }

  #markSelection({ side, start, end, text }) {
    const row = side.closest('.tr-row');
    if (!row) return null;

    this.#clearMarkVisuals();

    const mark = storage.setReadingMark(this.book.id, {
      chapterIndex: this.chapterIndex,
      chapterTitle: this.chapter?.title || '',
      blockIndex: Number(row.dataset.blockIndex),
      hash: row.dataset.hash,
      side: side.classList.contains('tr-trans') ? 'trans' : 'orig',
      start,
      end,
      excerpt: text.slice(0, 120),
      scrollRatio: this.scrollRatio,
    });

    this.#applyMark();
    window.getSelection()?.removeAllRanges();
    this.#emit('mark-changed', { mark });
    return mark;
  }

  /** Marca o parágrafo inteiro. Usado quando não há seleção. */
  markRow(row) {
    if (!row || !this.book) return null;

    this.#clearMarkVisuals();
    row.classList.add('is-marked');

    const mark = storage.setReadingMark(this.book.id, {
      chapterIndex: this.chapterIndex,
      chapterTitle: this.chapter?.title || '',
      blockIndex: Number(row.dataset.blockIndex),
      hash: row.dataset.hash,
      side: 'orig',
      start: null,
      end: null,
      excerpt: row.querySelector('.tr-orig').textContent.trim().slice(0, 120),
      scrollRatio: this.scrollRatio,
    });

    this.#emit('mark-changed', { mark });
    return mark;
  }

  /** Compatibilidade: tecla M e botão do rodapé passam por mark(). */
  markCurrentLine() { return this.mark(); }

  #clearMarkVisuals() {
    if (!this.container) return;
    for (const el of this.container.querySelectorAll('.tr-row.is-marked')) {
      el.classList.remove('is-marked');
    }
    for (const el of this.container.querySelectorAll('mark.reading-mark')) {
      unwrap(el);
    }
  }

  clearMark() {
    if (!this.book) return;
    this.#clearMarkVisuals();
    storage.clearReadingMark(this.book.id);
    this.#emit('mark-changed', { mark: null });
  }

  /**
   * Reencontra o bloco de uma âncora no capítulo atual.
   *
   * Pelo hash primeiro: sobrevive a mudança de fonte, largura e modo de leitura.
   * O índice é desempate para quando a mesma frase aparece mais de uma vez.
   * Serve tanto ao "parei aqui" quanto aos trechos salvos.
   */
  #findRowByAnchor(anchor) {
    if (!this.container || !anchor) return null;
    if (anchor.chapterIndex !== undefined && anchor.chapterIndex !== this.chapterIndex) return null;

    const matches = [...this.container.querySelectorAll(`.tr-row[data-hash="${anchor.hash}"]`)];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      return matches.find((r) => Number(r.dataset.blockIndex) === anchor.blockIndex) || matches[0];
    }
    // Texto mudou (outro idioma de origem, EPUB atualizado): cai no índice.
    return this.container.querySelector(`.tr-row[data-block-index="${anchor.blockIndex}"]`);
  }

  /**
   * Pinta o marcador no capítulo atual.
   * @returns {Element|null} o elemento para onde rolar
   */
  #applyMark() {
    this.#clearMarkVisuals();

    const mark = this.book ? storage.getReadingMark(this.book.id) : null;
    const row = this.#findRowByAnchor(mark);
    if (!row) return null;

    // Marcador de parágrafo inteiro (sem seleção).
    if (mark.start === null || mark.start === undefined) {
      row.classList.add('is-marked');
      return row;
    }

    const side = row.querySelector(mark.side === 'trans' ? '.tr-trans' : '.tr-orig');

    // A coluna marcada pode estar oculta no modo atual, ou a tradução ainda não
    // ter chegado. Destacar o parágrafo inteiro é melhor que não mostrar nada.
    if (!side || !side.textContent.trim() || side.offsetParent === null) {
      row.classList.add('is-marked');
      return row;
    }

    const range = rangeFromOffsets(side, mark.start, mark.end);
    if (!range) {
      row.classList.add('is-marked');
      return row;
    }

    const el = document.createElement('mark');
    el.className = 'reading-mark';
    try {
      wrapRange(range, el);
      return el;
    } catch {
      row.classList.add('is-marked');
      return row;
    }
  }

  /** Âncora do parágrafo da seleção, com o trecho selecionado como resumo. */
  selectionAnchor() {
    if (!this.container) return null;
    const selection = readSelection(this.container);
    const anchor = this.rowAnchor(selection?.side.closest('.tr-row'));
    return anchor && { ...anchor, excerpt: selection.text.slice(0, 120) };
  }

  /** Dados de âncora do parágrafo no topo — base de qualquer marca. */
  currentAnchor() {
    return this.rowAnchor(this.topVisibleRow());
  }

  rowAnchor(row) {
    if (!row || !this.book) return null;
    return {
      chapterIndex: this.chapterIndex,
      chapterTitle: this.chapter?.title || '',
      blockIndex: Number(row.dataset.blockIndex),
      hash: row.dataset.hash,
      excerpt: row.querySelector('.tr-orig').textContent.trim().slice(0, 120),
    };
  }

  /* ------------------------------ trechos salvos ------------------------------ */

  /** Fita discreta na margem dos parágrafos com trecho salvo neste capítulo. */
  refreshBookmarks() {
    if (!this.book || !this.container) return;

    for (const el of this.container.querySelectorAll('.has-bookmark')) {
      el.classList.remove('has-bookmark');
    }
    for (const bm of storage.getBookmarks(this.book.id)) {
      if (bm.chapterIndex !== this.chapterIndex) continue;
      this.#findRowByAnchor(bm)?.classList.add('has-bookmark');
    }
  }

  /** Vai até um trecho salvo, trocando de capítulo se necessário. */
  async goToBookmark(bm) {
    if (bm.chapterIndex !== this.chapterIndex) {
      await this.loadChapter(bm.chapterIndex, { anchor: bm });
      return;
    }
    const row = this.#findRowByAnchor(bm);
    if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else this.#restoreScroll(bm.scrollRatio || 0);
  }

  get hasMark() {
    return Boolean(this.book && storage.getReadingMark(this.book.id));
  }

  /** Elemento que representa o marcador na tela (seleção ou parágrafo). */
  #markElement() {
    return this.container?.querySelector('mark.reading-mark, .tr-row.is-marked') || null;
  }

  /** O marcador está na tela agora? Decide se o atalho de voltar aparece. */
  isMarkVisible() {
    const mark = this.book ? storage.getReadingMark(this.book.id) : null;
    if (!mark) return true;
    if (mark.chapterIndex !== this.chapterIndex) return false;

    const el = this.#markElement();
    if (!el) return false;

    const box = this.viewport.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    return rect.bottom > box.top && rect.top < box.bottom;
  }

  /** Vai até o marcador, trocando de capítulo se necessário. */
  async goToMark() {
    const mark = this.book ? storage.getReadingMark(this.book.id) : null;
    if (!mark) return false;

    if (mark.chapterIndex !== this.chapterIndex) {
      await this.loadChapter(mark.chapterIndex, { anchor: mark });
      return true;
    }

    const el = this.#markElement() || this.#applyMark();
    if (!el) return false;

    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Pulso rápido: sem ele, rolar até uma frase curta passa despercebido.
    el.classList.add('mark-pulse');
    setTimeout(() => el.classList.remove('mark-pulse'), 1400);

    this.#emit('mark-changed', { mark });
    return true;
  }

  /** Alça flutuante na margem: aparece ao passar o mouse sobre um parágrafo. */
  #setupMarkHandle() {
    const handle = document.createElement('button');
    handle.className = 'mark-handle';
    handle.type = 'button';
    handle.hidden = true;
    handle.title = 'Marcar como "parei aqui"';
    handle.setAttribute('aria-label', 'Marcar esta linha como onde parei');
    document.body.append(handle);
    this.markHandle = handle;

    let target = null;

    handle.addEventListener('click', () => {
      if (target) this.markRow(target);
      handle.hidden = true;
    });

    this.viewport.addEventListener('mousemove', (ev) => {
      const row = ev.target.closest?.('.tr-row');
      if (!row || !this.viewport.contains(row)) {
        if (ev.target !== handle) handle.hidden = true;
        return;
      }

      // mousemove dispara muito: só recalcula quando o parágrafo muda.
      if (row === target && !handle.hidden) return;

      target = row;
      const rect = row.getBoundingClientRect();
      const box = this.viewport.getBoundingClientRect();

      // Não mostrar a alça se o parágrafo saiu da área visível.
      if (rect.bottom < box.top || rect.top > box.bottom) { handle.hidden = true; return; }

      handle.hidden = false;
      handle.style.top = `${Math.max(box.top, rect.top)}px`;
      handle.style.left = `${Math.max(box.left + 2, rect.left - 26)}px`;
    });

    this.viewport.addEventListener('mouseleave', () => { handle.hidden = true; });
    // Posição é fixed: rolar deixaria a alça desalinhada do parágrafo.
    this.viewport.addEventListener('scroll', () => { handle.hidden = true; }, { passive: true });
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
