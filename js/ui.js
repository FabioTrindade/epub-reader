/**
 * Controle de interface: tema, preferências, sumário, biblioteca, notificações.
 *
 * Mantém o DOM isolado do resto — reader.js e translator.js não tocam em
 * elementos, apenas emitem eventos.
 */

import { notify } from './notifications.js';
import * as storage from './storage.js';
import * as db from './db.js';

export const $ = (sel) => document.querySelector(sel);

/* ---------------------------------- tema ---------------------------------- */

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

export function applyPrefs(prefs) {
  const root = document.documentElement;
  // Sem tamanho escolhido, vale o padrão do CSS (19px, ou 18px no celular).
  if (prefs.fontSize) root.style.setProperty('--reader-font-size', `${prefs.fontSize}px`);
  else root.style.removeProperty('--reader-font-size');
  root.style.setProperty('--reader-line-height', prefs.lineHeight);
  root.style.setProperty('--reader-font-family',
    prefs.fontFamily === 'sans' ? 'var(--font-sans)' : 'var(--font-serif)');
  root.dataset.markColor = prefs.markColor;
  applyTheme(prefs.theme);
}

/* --------------------------------- toasts --------------------------------- */

const MAX_TOASTS = 2;

export function toast(level, title, detail) {
  const el = document.createElement('div');
  el.className = `toast toast-${level}`;
  el.innerHTML = `<span class="toast-dot" aria-hidden="true"></span>
                  <div><strong></strong><p></p></div>`;
  el.querySelector('strong').textContent = title;
  el.querySelector('p').textContent = detail || '';
  const box = $('#toasts');
  box.append(el);

  // No máximo dois na tela: o mais antigo cede lugar (continua no sino).
  const shown = [...box.querySelectorAll('.toast:not(.leaving)')];
  for (const old of shown.slice(0, -MAX_TOASTS)) old.remove();

  setTimeout(() => {
    el.classList.add('leaving');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    // Sem transição (movimento reduzido), o transitionend não vem.
    setTimeout(() => el.remove(), 400);
  }, 5000);
}

/* ------------------------------ notificações ------------------------------ */

const relativeTime = (ts) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} d`;
};

/* ---------------------------------- menus ---------------------------------- */

/**
 * Menu suspenso ancorado a um botão (⋯, "Traduzindo N%").
 *
 * Fecha ao escolher um item, com Esc ou com clique fora — o mesmo contrato
 * de um menu nativo, sem o peso de um <dialog> modal.
 */
export class PopoverMenu {
  /** `trigger` pode ser null: menus de itens dinâmicos (cards) abrem por open(botão). */
  constructor(trigger, menu) {
    this.trigger = trigger;
    this.menu = menu;

    trigger?.addEventListener('click', () => (menu.hidden ? this.open() : this.close()));
    menu.addEventListener('click', (ev) => {
      if (ev.target.closest('[role="menuitem"]')) this.close();
    });
    document.addEventListener('pointerdown', (ev) => {
      if (!menu.hidden && !menu.contains(ev.target) && !this.trigger?.contains(ev.target)) this.close();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !menu.hidden) {
        this.close();
        this.trigger?.focus();
      }
    });
    window.addEventListener('resize', () => this.close());
  }

  open(trigger = this.trigger) {
    this.trigger = trigger;
    const rect = trigger.getBoundingClientRect();
    this.menu.hidden = false;
    this.menu.style.top = `${rect.bottom + 6}px`;
    // Alinhado pela direita do botão: os gatilhos ficam no canto direito do topo.
    this.menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.menu.querySelector('[role="menuitem"]')?.focus();
  }

  close() {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.trigger?.setAttribute('aria-expanded', 'false');
  }
}

/** Pergunta antes de uma ação; resolve true se o leitor confirmar. */
export function confirmDialog({ title, text, action, destructive = false }) {
  const dialog = $('#dlg-confirm');
  const ok = $('#confirm-ok');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  ok.textContent = action;
  ok.classList.toggle('is-destructive', destructive);
  dialog.returnValue = '';
  // showModal foca o primeiro botão, "Cancelar": Enter por engano não apaga nada.
  dialog.showModal();

  return new Promise((resolve) => {
    const confirm = () => dialog.close('ok');
    ok.addEventListener('click', confirm);
    dialog.addEventListener('close', () => {
      ok.removeEventListener('click', confirm);
      resolve(dialog.returnValue === 'ok');
    }, { once: true });
  });
}

export class NotificationUI {
  constructor() {
    this.badge = $('#notif-badge');
    this.dot = $('#more-dot');
    this.dialog = $('#dlg-notifications');
    this.list = $('#notif-list');

    $('#btn-notifications').addEventListener('click', () => this.open());
    $('#btn-clear-notifications').addEventListener('click', () => {
      notify.clear();
      this.render();
    });
    $('#btn-copy-diagnostic').addEventListener('click', () => this.copyDiagnostic());
    $('#menu-copy-diagnostic').addEventListener('click', () => this.copyDiagnostic());
    enableSheetDrag(this.dialog);

    notify.addEventListener('change', (ev) => {
      this.refreshBadge();
      if (this.dialog.open) this.render();

      // Todo evento vai para o sino; só warn/error também viram toast.
      const { entry, isNew } = ev.detail || {};
      if (entry && isNew && entry.level !== 'info') {
        toast(entry.level, entry.title, entry.detail);
      }
    });

    this.refreshBadge();
  }

  refreshBadge() {
    const count = notify.unreadCount;
    const severity = notify.severity || 'info';
    this.badge.hidden = count === 0;
    this.badge.textContent = count > 9 ? '9+' : String(count);
    this.badge.dataset.level = severity;
    $('#btn-notifications').setAttribute(
      'aria-label',
      count ? `Notificações (${count} não lidas)` : 'Notificações'
    );

    // O ponto no ⋯ só chama atenção para aviso ou erro: informação pura
    // não justifica tirar o leitor do texto.
    const alert = count > 0 && severity !== 'info';
    this.dot.hidden = !alert;
    this.dot.dataset.level = severity;
    $('#btn-more').setAttribute('aria-label', alert ? 'Mais opções (há avisos novos)' : 'Mais opções');
  }

  open() {
    this.render();
    this.dialog.showModal();
    placePopover(this.dialog, $('#btn-more'));
    // Abrir marca como lidas, mas a lista continua consultável.
    notify.markAllRead();
    this.refreshBadge();
  }

  render() {
    const entries = notify.list();
    this.list.textContent = '';

    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'muted empty';
      empty.textContent = 'Nenhuma notificação. Problemas de tradução, sumário ou armazenamento aparecem aqui.';
      this.list.append(empty);
      return;
    }

    for (const entry of entries) {
      const item = document.createElement('div');
      item.className = `notif notif-${entry.level}`;

      const head = document.createElement('div');
      head.className = 'notif-head';

      const icon = document.createElement('span');
      icon.className = 'notif-dot';
      icon.setAttribute('aria-hidden', 'true');

      const title = document.createElement('strong');
      title.textContent = entry.title;

      const count = document.createElement('span');
      count.className = 'notif-count';
      if (entry.count > 1) count.textContent = `×${entry.count}`;

      const time = document.createElement('span');
      time.className = 'notif-time muted small';
      time.textContent = relativeTime(entry.timestamp);

      head.append(icon, title, count, time);
      item.append(head);

      if (entry.detail) {
        const detail = document.createElement('p');
        detail.className = 'notif-detail small muted';
        detail.textContent = entry.detail;
        item.append(detail);
      }

      const code = document.createElement('code');
      code.className = 'notif-code';
      code.textContent = entry.code;
      item.append(code);

      this.list.append(item);
    }
  }

  async copyDiagnostic() {
    const text = notify.toDiagnosticText();
    try {
      await navigator.clipboard.writeText(text);
      toast('info', 'Diagnóstico copiado', 'Cole onde for relatar o problema.');
    } catch {
      // Clipboard bloqueado: mostrar o texto ainda permite copiar manualmente.
      // Abre a lista porque o pedido pode ter vindo do menu ⋯ ou do "Aa".
      if (!this.dialog.open) this.open();
      const area = document.createElement('textarea');
      area.className = 'diagnostic-fallback';
      area.value = text;
      area.readOnly = true;
      this.list.prepend(area);
      area.select();
    }
  }
}

/* --------------------------------- sidebar -------------------------------- */

export class SidebarUI {
  constructor(onSelectChapter, onSelectBookmark, onRemoveBookmark) {
    this.el = $('#sidebar');
    this.scrim = $('#sidebar-scrim');
    this.tocPanel = $('#panel-toc');
    this.bookmarksPanel = $('#panel-bookmarks');
    this.onSelectChapter = onSelectChapter;
    this.onSelectBookmark = onSelectBookmark;
    this.onRemoveBookmark = onRemoveBookmark;
    this.chapters = [];

    // No computador o sumário abre pelo topo; no celular, pelo rodapé.
    this.toggles = [$('#btn-sidebar'), $('#btn-toc')];
    for (const btn of this.toggles) btn.addEventListener('click', () => this.toggle());
    this.scrim.addEventListener('click', () => this.close());

    // A partir de 1024px o sumário é uma coluna fixa, que o leitor pode
    // recolher; a escolha fica salva.
    this.#setCollapsed(storage.getPrefs().sidebarCollapsed, false);
    DESKTOP.addEventListener('change', () => this.#syncExpanded());

    for (const tab of document.querySelectorAll('.sidebar-tabs button')) {
      tab.addEventListener('click', () => this.#selectTab(tab.dataset.panel));
    }

    $('#toc-filter').addEventListener('input', (ev) => this.#filter(ev.target.value));
  }

  #selectTab(panel) {
    for (const tab of document.querySelectorAll('.sidebar-tabs button')) {
      tab.setAttribute('aria-selected', String(tab.dataset.panel === panel));
    }
    this.tocPanel.hidden = panel !== 'toc';
    this.bookmarksPanel.hidden = panel !== 'bookmarks';
    $('.sidebar-search').hidden = panel !== 'toc';
  }

  #filter(term) {
    const q = term.trim().toLowerCase();
    for (const link of this.tocPanel.children) {
      link.hidden = q ? !link.textContent.toLowerCase().includes(q) : false;
    }
  }

  toggle() {
    if (DESKTOP.matches) this.#setCollapsed(!document.body.classList.contains('sidebar-collapsed'));
    else if (this.el.classList.contains('is-open')) this.close();
    else this.open();
  }

  #setCollapsed(collapsed, save = true) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    if (save) storage.setPrefs({ sidebarCollapsed: collapsed });
    this.#syncExpanded();
  }

  #syncExpanded() {
    const expanded = DESKTOP.matches
      ? !document.body.classList.contains('sidebar-collapsed')
      : this.el.classList.contains('is-open');
    for (const btn of this.toggles) btn.setAttribute('aria-expanded', String(expanded));
  }

  open() {
    this.el.classList.add('is-open');
    this.scrim.hidden = false;
    for (const btn of this.toggles) btn.setAttribute('aria-expanded', 'true');
  }

  close() {
    this.el.classList.remove('is-open');
    this.scrim.hidden = true;
    for (const btn of this.toggles) btn.setAttribute('aria-expanded', 'false');
  }

  renderToc(chapters) {
    this.chapters = chapters;
    this.tocPanel.textContent = '';

    for (const chapter of chapters) {
      // Continuação de outra entrada (ver assignTocPositions): sem item próprio.
      if (!chapter.inToc) continue;

      const link = document.createElement('button');
      link.className = 'toc-item';
      link.dataset.position = chapter.tocPosition;
      link.style.paddingLeft = `${0.9 + (chapter.level || 0) * 0.8}rem`;
      link.textContent = chapter.title || `Capítulo ${chapter.index + 1}`;
      link.addEventListener('click', () => {
        this.onSelectChapter(chapter.index);
        if (!DESKTOP.matches) this.close();
      });
      this.tocPanel.append(link);
    }
  }

  highlight(index) {
    // Um pedaço fora do sumário acende a entrada que ele continua.
    const position = this.chapters[index]?.tocPosition;
    for (const item of this.tocPanel.children) {
      const active = Number(item.dataset.position) === position;
      item.classList.toggle('is-active', active);
      if (active) item.scrollIntoView({ block: 'nearest' });
    }
  }

  renderBookmarks(bookmarks) {
    this.bookmarksPanel.textContent = '';

    if (!bookmarks.length) {
      const empty = document.createElement('p');
      empty.className = 'muted empty small';
      empty.textContent = 'Nenhum trecho salvo ainda. Selecione um trecho e toque em Salvar, ou use a tecla B.';
      this.bookmarksPanel.append(empty);
      return;
    }

    for (const bm of bookmarks) {
      const item = document.createElement('div');
      item.className = 'bookmark-item';

      // O trecho em si vem primeiro, na fonte do livro; o capítulo, embaixo.
      const go = document.createElement('button');
      go.className = 'bookmark-go';
      go.innerHTML = `<span class="bm-excerpt"></span><span class="bm-chapter"></span>`;
      go.querySelector('.bm-excerpt').textContent = bm.excerpt || '';
      go.querySelector('.bm-chapter').textContent = bm.chapterTitle || `Capítulo ${bm.chapterIndex + 1}`;
      go.addEventListener('click', () => {
        this.onSelectBookmark(bm);
        if (!DESKTOP.matches) this.close();
      });

      const del = document.createElement('button');
      del.className = 'icon-btn small-btn';
      del.setAttribute('aria-label', 'Remover trecho salvo');
      del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      del.addEventListener('click', () => this.onRemoveBookmark(bm.id));

      item.append(go, del);
      this.bookmarksPanel.append(item);
    }
  }
}

/* -------------------------------- biblioteca ------------------------------- */

/** Capa tipográfica para livros sem imagem: seis tons fixos, escolhidos pelo título. */
const COVER_TONES = [
  { bg: '#1F2A37', fg: '#F3F4F6', sub: '#C7CBD1' },
  { bg: '#E9E2D6', fg: '#3B2F22', sub: '#6B5A45' },
  { bg: '#DCE7E3', fg: '#17352D', sub: '#3D5A51' },
  { bg: '#E6E1F0', fg: '#2E2343', sub: '#5B4E70' },
  { bg: '#F3E1D8', fg: '#4A2418', sub: '#7A4A3A' },
  { bg: '#F2F2EF', fg: '#18181B', sub: '#55555C' },
];

function hashString(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) | 0;
  return Math.abs(h);
}

function readAgo(ts) {
  if (!ts) return '';
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days < 1) return 'lido hoje';
  if (days === 1) return 'lido ontem';
  if (days < 7) return `lido há ${days} dias`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `lido há ${weeks} semana${weeks > 1 ? 's' : ''}`;
  }
  const months = Math.floor(days / 30);
  return months < 12 ? `lido há ${months} ${months > 1 ? 'meses' : 'mês'}` : 'lido há mais de um ano';
}

/** Onde o leitor está num livro, do jeito que a biblioteca mostra. */
function bookState(book) {
  const progress = storage.getProgress(book.id);
  if (!progress) return { started: false };

  const { ratio, exact } = storage.computeProgress(book.chapterLengths, book.chapterCount,
    progress.chapterIndex, progress.scrollRatio);
  const percent = Math.round(ratio * 100);
  // O capítulo vai pelo título, como no rodapé da leitura. Progresso gravado
  // antes de o título ser guardado usa o do "parei aqui", se for o mesmo
  // capítulo; sem nenhum dos dois, a biblioteca mostra só o percentual.
  const mark = storage.getReadingMark(book.id);
  const chapterTitle = progress.chapterTitle
    || (mark?.chapterIndex === progress.chapterIndex ? mark.chapterTitle : '')
    || '';
  // O "~" avisa que o livro ainda não foi medido (importado antes da medição).
  return { started: true, percent, label: `${exact ? '' : '~'}${percent}%`, done: percent >= 99, chapterTitle };
}

const make = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
};

const ICONS = {
  more: '<svg viewBox="0 0 24 24" aria-hidden="true" class="icon-fill"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>',
};

/** Campo de arquivo visualmente escondido, mas alcançável pelo teclado. */
const fileInput = () => {
  const input = make('input', 'epub-input sr-only');
  input.type = 'file';
  input.accept = '.epub,application/epub+zip';
  return input;
};

export class LibraryUI {
  constructor({ onOpen, onContinue, onDelete }) {
    this.view = $('#welcome');
    this.el = $('#library');
    this.onOpen = onOpen;
    this.onContinue = onContinue;
    this.urls = [];

    this.menu = new PopoverMenu(null, $('#menu-book'));
    this.menuBook = null;
    $('#menu-remove-book').addEventListener('click', () => {
      if (this.menuBook) onDelete(this.menuBook);
    });
  }

  async render() {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];

    const books = await db.listBooks();
    this.view.classList.toggle('is-empty', !books.length);
    if (!books.length) {
      this.el.replaceChildren(this.#empty());
      return;
    }

    const items = books.map((book) => ({ book, state: bookState(book) }));
    // A lista vem do último aberto para o primeiro: o primeiro iniciado e não
    // concluído é o "continuar lendo".
    const current = items.find(({ state }) => state.started && !state.done);
    this.el.replaceChildren(...[current && this.#continue(current), this.#shelf(items)].filter(Boolean));
  }

  /** Mostra um card "Importando…" enquanto um livro novo é lido. */
  showImporting(name) {
    const grid = this.el.querySelector('.shelf-grid');
    if (!grid) return;
    const card = make('article', 'book-card is-importing');
    const cover = make('div', 'cover is-skeleton');
    const info = make('span', 'book-info');
    info.append(make('span', 'book-title', name.replace(/\.epub$/i, '')), make('span', 'book-state', 'Importando…'));
    card.append(cover, info);
    grid.prepend(card);
  }

  #cover(book) {
    const cover = make('div', 'cover');
    if (book.cover) {
      const url = URL.createObjectURL(book.cover);
      this.urls.push(url);
      const img = make('img');
      img.src = url;
      img.alt = '';
      cover.append(img);
      return cover;
    }
    const tone = COVER_TONES[hashString(book.title || '') % COVER_TONES.length];
    cover.classList.add('is-typographic');
    cover.style.setProperty('--cover-bg', tone.bg);
    cover.style.setProperty('--cover-fg', tone.fg);
    cover.style.setProperty('--cover-sub', tone.sub);
    cover.append(make('span', 'cover-title', book.title), make('span', 'cover-author', book.author));
    return cover;
  }

  #bar(percent, label) {
    const row = make('span', 'progress-row');
    const bar = make('span', 'bar');
    const fill = make('span');
    fill.style.width = `${percent}%`;
    bar.append(fill);
    row.append(bar, make('span', 'progress-label', label));
    return row;
  }

  #continue({ book, state }) {
    const section = make('section', 'continue');
    section.setAttribute('aria-labelledby', 'continue-label');
    const label = make('h2', 'section-label', 'Continuar lendo');
    label.id = 'continue-label';

    const card = make('div', 'continue-card');
    const body = make('div', 'continue-body');
    const head = make('div', 'continue-head');
    head.append(
      make('span', 'section-label card-label', 'Continuar lendo'),
      make('span', 'continue-title', book.title),
      make('span', 'continue-meta meta-long',
        [book.author, state.chapterTitle, readAgo(book.lastOpenedAt)].filter(Boolean).join(' · ')),
      make('span', 'continue-meta meta-short', state.chapterTitle || readAgo(book.lastOpenedAt)),
    );
    body.append(head);

    // A frase marcada como "parei aqui", na cor da marca: é o que lembra o leitor
    // de onde estava, melhor que um número de capítulo.
    const mark = storage.getReadingMark(book.id);
    if (mark?.excerpt) {
      const quote = make('p', 'continue-quote');
      quote.append(make('mark', 'reading-mark', mark.excerpt), ' …');
      body.append(quote);
    }

    body.append(this.#bar(state.percent, state.label));
    const go = make('button', 'continue-btn', 'Continuar de onde parei');
    go.addEventListener('click', () => this.onContinue(book.id));
    body.append(go);

    card.append(this.#cover(book), body);
    section.append(label, card);
    return section;
  }

  #shelf(items) {
    const section = make('section', 'shelf');
    section.setAttribute('aria-labelledby', 'shelf-label');
    const head = make('div', 'shelf-head');
    const title = make('h2', 'section-label');
    title.id = 'shelf-label';
    const count = items.length === 1 ? '1 livro' : `${items.length} livros`;
    title.append(make('span', 'label-long', `Sua biblioteca · ${count}`), make('span', 'label-short', 'Todos os livros'));
    head.append(title);

    const grid = make('div', 'shelf-grid');

    // Busca só aparece quando a lista já não cabe de relance.
    if (items.length >= 6) {
      const search = make('label', 'shelf-search');
      search.innerHTML = ICONS.search;
      const input = make('input');
      input.type = 'search';
      input.placeholder = 'Buscar título ou autor';
      input.setAttribute('aria-label', 'Buscar na biblioteca');
      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        for (const card of grid.querySelectorAll('.book-card')) {
          card.hidden = Boolean(q) && !card.dataset.search.includes(q);
        }
      });
      search.append(input);
      head.append(search);
    }

    for (const item of items) grid.append(this.#card(item));

    const add = make('label', 'add-card');
    add.innerHTML = `${ICONS.upload}<span class="add-long">Arraste um .epub<br>ou clique para escolher</span><span class="add-short">Abrir um arquivo .epub</span>`;
    add.append(fileInput());
    grid.append(add);

    section.append(head, grid);
    return section;
  }

  #card({ book, state }) {
    const card = make('article', 'book-card');
    card.dataset.search = `${book.title} ${book.author}`.toLowerCase();

    const open = make('button', 'book-open');
    const info = make('span', 'book-info');
    info.append(make('span', 'book-title', book.title), make('span', 'book-author', book.author));

    if (!state.started) {
      info.append(make('span', 'book-state', 'Não iniciado'));
    } else if (state.done) {
      const done = make('span', 'book-state is-done');
      done.innerHTML = ICONS.check;
      done.append('Concluído');
      info.append(done);
    } else {
      const progress = this.#bar(state.percent, state.label);
      progress.classList.add('book-state');
      if (state.chapterTitle) progress.title = state.chapterTitle;
      info.append(progress);
    }

    open.append(this.#cover(book), info);
    open.addEventListener('click', () => this.onOpen(book.id));

    const more = make('button', 'icon-btn book-more');
    more.innerHTML = ICONS.more;
    more.setAttribute('aria-label', `Opções de ${book.title}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', () => {
      if (!this.menu.menu.hidden && this.menu.trigger === more) return this.menu.close();
      this.menuBook = book;
      this.menu.open(more);
    });

    card.append(open, more);
    return card;
  }

  /** Primeira abertura: nenhum livro ainda. */
  #empty() {
    const wrap = make('div', 'library-empty');
    const drop = make('label', 'empty-drop');
    drop.innerHTML = ICONS.upload;
    drop.append(
      make('strong', null, 'Abra um livro em EPUB'),
      make('span', 'empty-text', 'Arraste o arquivo para cá ou escolha no seu computador. Nada é enviado para servidor: o livro é lido e guardado no seu navegador.'),
      make('span', 'primary-btn', 'Escolher arquivo'),
      fileInput(),
    );
    const link = make('a', 'empty-link', 'Onde encontrar livros gratuitos');
    link.href = 'https://github.com/FabioTrindade/epub-reader#onde-encontrar-livros-gratuitos';
    link.target = '_blank';
    link.rel = 'noopener';
    wrap.append(drop, link);
    return wrap;
  }
}

/* -------------------------------- aparência -------------------------------- */

const SIZE_MIN = 14;
const SIZE_MAX = 28;
const SIZE_DOTS = 6;

/** Sem escolha salva, o tamanho é o padrão do aparelho: 19px, ou 18px no celular. */
export function effectiveFontSize(prefs) {
  return prefs.fontSize ?? (MOBILE.matches ? 18 : 19);
}

const setPressed = (buttons, isOn) => {
  for (const btn of buttons) btn.setAttribute('aria-pressed', String(isOn(btn)));
};

/**
 * Painel "Aa": tamanho, fonte, espaçamento, tema, cor da marca, idioma e
 * armazenamento. Cada toque grava e aplica na hora — não há "salvar".
 */
export class AppearanceUI {
  constructor({ onChange, onClearCache, onCopyDiagnostic, onCancelTranslation }) {
    this.dialog = $('#dlg-appearance');
    const all = (sel) => this.dialog.querySelectorAll(sel);

    // Há um "Aa" no topo da leitura e outro no da biblioteca.
    for (const btn of document.querySelectorAll('[data-action="appearance"]')) {
      btn.addEventListener('click', () => this.open(btn));
    }

    const set = (key, value) => {
      const prefs = storage.setPrefs({ [key]: value });
      applyPrefs(prefs);
      this.sync(prefs);
      onChange(key, value, prefs);
    };
    const step = (delta) => {
      const size = effectiveFontSize(storage.getPrefs()) + delta;
      set('fontSize', Math.min(SIZE_MAX, Math.max(SIZE_MIN, size)));
    };

    $('#size-down').addEventListener('click', () => step(-1));
    $('#size-up').addEventListener('click', () => step(1));
    for (const btn of all('[data-font]')) btn.addEventListener('click', () => set('fontFamily', btn.dataset.font));
    for (const btn of all('[data-spacing]')) btn.addEventListener('click', () => set('lineHeight', Number(btn.dataset.spacing)));
    for (const btn of all('[data-theme-choice]')) btn.addEventListener('click', () => set('theme', btn.dataset.themeChoice));
    for (const btn of all('.swatch')) btn.addEventListener('click', () => set('markColor', btn.dataset.color));
    for (const btn of all('[data-lang]')) {
      btn.addEventListener('click', () => {
        set('targetLang', btn.dataset.lang);
        this.show('main');
      });
    }
    for (const btn of all('[data-goto]')) btn.addEventListener('click', () => this.show(btn.dataset.goto));

    $('#btn-clear-cache').addEventListener('click', onClearCache);
    $('#appearance-copy-diagnostic').addEventListener('click', onCopyDiagnostic);
    $('#appearance-cancel').addEventListener('click', () => {
      onCancelTranslation();
      this.dialog.close();
    });

    this.dialog.addEventListener('close', () => this.show('main'));
    enableSheetDrag(this.dialog);
  }

  show(view) {
    for (const el of this.dialog.querySelectorAll('.sheet-view')) el.hidden = el.dataset.view !== view;
    if (view === 'storage') this.#refreshStorage();
  }

  sync(prefs) {
    const all = (sel) => this.dialog.querySelectorAll(sel);
    const size = effectiveFontSize(prefs);

    // 15 tamanhos em 6 pontos: proporcional, sempre pelo menos um aceso.
    const lit = Math.round(((size - SIZE_MIN) / (SIZE_MAX - SIZE_MIN)) * (SIZE_DOTS - 1)) + 1;
    const dots = $('#size-dots');
    dots.replaceChildren(...Array.from({ length: SIZE_DOTS }, (_, i) => {
      const dot = document.createElement('span');
      if (i < lit) dot.className = 'is-on';
      return dot;
    }));
    dots.setAttribute('aria-label', `Tamanho ${size}px, de ${SIZE_MIN} a ${SIZE_MAX}`);
    $('#size-down').disabled = size <= SIZE_MIN;
    $('#size-up').disabled = size >= SIZE_MAX;

    setPressed(all('[data-font]'), (b) => b.dataset.font === prefs.fontFamily);
    // Entrelinhas salvas antes do painel podem não ser 1.4/1.7/2: acende a mais próxima.
    const spacing = [...all('[data-spacing]')];
    const nearest = spacing.reduce((best, b) =>
      Math.abs(b.dataset.spacing - prefs.lineHeight) < Math.abs(best.dataset.spacing - prefs.lineHeight) ? b : best);
    setPressed(spacing, (b) => b === nearest);
    setPressed(all('[data-theme-choice]'), (b) => b.dataset.themeChoice === prefs.theme);
    setPressed(all('.swatch'), (b) => b.dataset.color === prefs.markColor);
    setPressed(all('[data-lang]'), (b) => b.dataset.lang === prefs.targetLang);
    $('#lang-current').textContent = this.dialog.querySelector(`[data-lang="${prefs.targetLang}"]`)?.textContent || prefs.targetLang;
  }

  open(anchor) {
    this.sync(storage.getPrefs());
    this.show('main');
    this.#refreshStorage();
    this.dialog.showModal();
    placePopover(this.dialog, anchor);
  }

  async #refreshStorage() {
    const estimate = await db.estimateUsage();
    const used = estimate ? `${(estimate.usage / 1024 / 1024).toFixed(1)} MB` : '';
    $('#storage-short').textContent = used;
    $('#storage-info').textContent = estimate
      ? `${used} usados de ~${(estimate.quota / 1024 / 1024 / 1024).toFixed(1)} GB disponíveis neste navegador.`
      : 'Uso de armazenamento indisponível neste navegador.';
  }
}

/* ------------------------------ popover e painel ---------------------------- */

const MOBILE = window.matchMedia('(max-width: 768px)');
const DESKTOP = window.matchMedia('(min-width: 1024px)');

/**
 * No computador, painéis como o "Aa" abrem como popover sob o botão que os
 * chamou. No celular o CSS os encaixa no rodapé e a posição é ignorada.
 */
export function placePopover(dialog, anchor) {
  if (!anchor || MOBILE.matches) {
    dialog.style.top = '';
    dialog.style.left = '';
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const width = dialog.offsetWidth;
  dialog.style.top = `${rect.bottom + 8}px`;
  dialog.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
}

/** No celular, o painel fecha arrastando a alça para baixo. */
export function enableSheetDrag(sheet, onClose = () => sheet.close()) {
  const handle = sheet.querySelector('.sheet-handle');
  if (!handle) return;
  let startY = null;

  handle.addEventListener('pointerdown', (ev) => {
    startY = ev.clientY;
    handle.setPointerCapture(ev.pointerId);
    sheet.style.transition = 'none';
  });
  handle.addEventListener('pointermove', (ev) => {
    if (startY === null) return;
    sheet.style.transform = `translateY(${Math.max(0, ev.clientY - startY)}px)`;
  });
  const end = (ev) => {
    if (startY === null) return;
    const dragged = ev.clientY - startY;
    startY = null;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dragged > 80) onClose();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/* --------------------------------- diálogos -------------------------------- */

export function wireDialogs() {
  for (const dialog of document.querySelectorAll('dialog')) {
    for (const btn of dialog.querySelectorAll('[data-close]')) {
      btn.addEventListener('click', () => dialog.close());
    }
    // Clique no backdrop fecha: o <dialog> nativo não faz isso sozinho. O alvo
    // também é o dialog num clique no seu próprio padding, então confere se
    // o ponto caiu fora da caixa.
    dialog.addEventListener('click', (ev) => {
      if (ev.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (!inside) dialog.close();
    });
  }
}
