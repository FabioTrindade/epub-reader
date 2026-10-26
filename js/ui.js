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
  root.style.setProperty('--reader-font-size', `${prefs.fontSize}px`);
  root.style.setProperty('--reader-line-height', prefs.lineHeight);
  root.style.setProperty('--reader-font-family',
    prefs.fontFamily === 'sans' ? 'var(--font-sans)' : 'var(--font-serif)');
  root.dataset.markColor = prefs.markColor;
  applyTheme(prefs.theme);
}

/* --------------------------------- toasts --------------------------------- */

const LEVEL_ICON = { info: 'ℹ', warn: '⚠', error: '✕' };

export function toast(level, title, detail) {
  const el = document.createElement('div');
  el.className = `toast toast-${level}`;
  el.innerHTML = `<span class="toast-icon">${LEVEL_ICON[level] || 'ℹ'}</span>
                  <div><strong></strong><p class="small muted"></p></div>`;
  el.querySelector('strong').textContent = title;
  el.querySelector('p').textContent = detail || '';
  $('#toasts').append(el);

  setTimeout(() => {
    el.classList.add('leaving');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
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

export class NotificationUI {
  constructor() {
    this.badge = $('#notif-badge');
    this.dialog = $('#dlg-notifications');
    this.list = $('#notif-list');

    $('#btn-notifications').addEventListener('click', () => this.open());
    $('#btn-clear-notifications').addEventListener('click', () => {
      notify.clear();
      this.render();
    });
    $('#btn-copy-diagnostic').addEventListener('click', () => this.copyDiagnostic());

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
    this.badge.hidden = count === 0;
    this.badge.textContent = count > 9 ? '9+' : String(count);
    this.badge.dataset.level = notify.severity || 'info';
    $('#btn-notifications').setAttribute(
      'aria-label',
      count ? `Notificações (${count} não lidas)` : 'Notificações'
    );
  }

  open() {
    this.render();
    this.dialog.showModal();
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
      icon.className = 'notif-icon';
      icon.textContent = LEVEL_ICON[entry.level];

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

    $('#btn-sidebar').addEventListener('click', () => this.toggle());
    this.scrim.addEventListener('click', () => this.close());

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

  toggle() { this.el.classList.contains('is-open') ? this.close() : this.open(); }

  open() {
    this.el.classList.add('is-open');
    this.scrim.hidden = false;
    $('#btn-sidebar').setAttribute('aria-expanded', 'true');
  }

  close() {
    this.el.classList.remove('is-open');
    this.scrim.hidden = true;
    $('#btn-sidebar').setAttribute('aria-expanded', 'false');
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
        if (window.matchMedia('(max-width: 1023px)').matches) this.close();
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
      empty.textContent = 'Nenhum marcador ainda. Use o ícone de marcador no rodapé.';
      this.bookmarksPanel.append(empty);
      return;
    }

    for (const bm of bookmarks) {
      const item = document.createElement('div');
      item.className = 'bookmark-item';

      const go = document.createElement('button');
      go.className = 'bookmark-go';
      go.innerHTML = `<strong></strong><span class="small muted"></span>`;
      go.querySelector('strong').textContent = bm.chapterTitle || `Capítulo ${bm.chapterIndex + 1}`;
      go.querySelector('span').textContent = bm.excerpt || '';
      go.addEventListener('click', () => this.onSelectBookmark(bm));

      const del = document.createElement('button');
      del.className = 'icon-btn small-btn';
      del.setAttribute('aria-label', 'Remover marcador');
      del.textContent = '×';
      del.addEventListener('click', () => this.onRemoveBookmark(bm.id));

      item.append(go, del);
      this.bookmarksPanel.append(item);
    }
  }
}

/* -------------------------------- biblioteca ------------------------------- */

export class LibraryUI {
  constructor(onOpenBook, onDeleteBook) {
    this.el = $('#library');
    this.onOpenBook = onOpenBook;
    this.onDeleteBook = onDeleteBook;
    this.urls = [];
  }

  async render() {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];

    const books = await db.listBooks();
    this.el.textContent = '';
    if (!books.length) return;

    const heading = document.createElement('h3');
    heading.textContent = 'Meus livros';
    this.el.append(heading);

    const grid = document.createElement('div');
    grid.className = 'library-grid';

    for (const book of books) {
      const card = document.createElement('div');
      card.className = 'book-card';

      const open = document.createElement('button');
      open.className = 'book-open';

      const cover = document.createElement('div');
      cover.className = 'book-cover';
      open.append(cover);

      if (book.cover) {
        const url = URL.createObjectURL(book.cover);
        this.urls.push(url);
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        cover.append(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'book-placeholder';
        placeholder.textContent = book.title.slice(0, 2).toUpperCase();
        cover.append(placeholder);
      }

      const meta = document.createElement('div');
      meta.className = 'book-meta';
      const t = document.createElement('strong');
      t.textContent = book.title;
      const a = document.createElement('span');
      a.className = 'small muted';
      a.textContent = book.author;
      meta.append(t, a);

      const progress = storage.getProgress(book.id);
      const { ratio, exact } = progress
        ? storage.computeProgress(book.chapterLengths, book.chapterCount,
            progress.chapterIndex, progress.scrollRatio)
        : { ratio: 0, exact: true };

      const percent = Math.round(ratio * 100);
      const done = percent >= 99;

      // Barra na base da capa: dá para varrer o grid inteiro de relance.
      if (progress) {
        const bar = document.createElement('div');
        bar.className = 'book-bar';
        if (done) bar.classList.add('is-done');
        const fill = document.createElement('span');
        fill.style.width = `${Math.max(percent, 2)}%`;
        bar.append(fill);
        cover.append(bar);
      }

      const p = document.createElement('span');
      p.className = 'small book-progress';

      if (!progress) {
        p.classList.add('muted', 'is-single');
        p.textContent = 'Não iniciado';
      } else {
        if (done) p.classList.add('is-done');

        // Capítulo à esquerda, percentual à direita: onde estou e quanto já li.
        const chapter = document.createElement('span');
        chapter.className = 'book-chapter';
        // Contar pelo sumário, como a lateral; tocPositions falta em livros
        // importados antes dele existir, até a próxima abertura preencher.
        const position = book.tocPositions?.[progress.chapterIndex];
        chapter.textContent = position != null
          ? `Capítulo ${position + 1} de ${book.tocPositions.at(-1) + 1}`
          : `Capítulo ${progress.chapterIndex + 1} de ${book.chapterCount}`;
        // Em cards estreitos o texto trunca e "de N" é o primeiro a sumir.
        chapter.title = chapter.textContent;

        const pct = document.createElement('span');
        pct.className = 'book-percent';
        // O "~" avisa que a medição do livro ainda não existe (importado antes).
        pct.textContent = `${exact ? '' : '~'}${percent}%`;

        p.append(chapter, pct);
        if (!exact) p.title = 'Percentual aproximado até a próxima abertura do livro';
      }

      meta.append(p);

      open.append(meta);
      open.addEventListener('click', () => this.onOpenBook(book.id));

      const del = document.createElement('button');
      del.className = 'icon-btn small-btn book-delete';
      del.setAttribute('aria-label', `Remover ${book.title}`);
      del.textContent = '×';
      del.addEventListener('click', () => this.onDeleteBook(book));

      card.append(open, del);
      grid.append(card);
    }

    this.el.append(grid);
  }
}

/* ------------------------------- configurações ----------------------------- */

export class SettingsUI {
  constructor(onChange, onClearCache) {
    this.dialog = $('#dlg-settings');
    this.onChange = onChange;

    $('#btn-settings').addEventListener('click', () => this.open());
    $('#btn-clear-cache').addEventListener('click', onClearCache);

    this.bindings = [
      ['#set-font-size', 'fontSize', Number, '#out-font-size', (v) => `${v}px`],
      ['#set-line-height', 'lineHeight', Number, '#out-line-height', (v) => v],
      ['#set-font-family', 'fontFamily', String, null, null],
      ['#set-mark-color', 'markColor', String, null, null],
      ['#set-theme', 'theme', String, null, null],
      ['#set-target-lang', 'targetLang', String, null, null],
    ];

    for (const [sel, key, cast, outSel, fmt] of this.bindings) {
      const apply = (ev) => {
        const value = cast(ev.target.value);
        const prefs = storage.setPrefs({ [key]: value });
        if (outSel) $(outSel).textContent = fmt(value);
        applyPrefs(prefs);
        this.onChange(key, value, prefs);
      };
      // 'input' cobre o arrastar dos sliders; 'change' é o evento canônico do
      // <select> e o único garantido em navegação por teclado.
      $(sel).addEventListener('input', apply);
      $(sel).addEventListener('change', apply);
    }
  }

  sync(prefs) {
    for (const [sel, key, , outSel, fmt] of this.bindings) {
      $(sel).value = prefs[key];
      if (outSel) $(outSel).textContent = fmt(prefs[key]);
    }
  }

  async open() {
    const estimate = await db.estimateUsage();
    $('#storage-info').textContent = estimate
      ? `${(estimate.usage / 1024 / 1024).toFixed(1)} MB usados de ~${(estimate.quota / 1024 / 1024 / 1024).toFixed(1)} GB disponíveis`
      : 'Uso de armazenamento indisponível neste navegador.';
    this.dialog.showModal();
  }
}

/* --------------------------------- diálogos -------------------------------- */

export function wireDialogs() {
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
    // Clique no backdrop fecha: o <dialog> nativo não faz isso sozinho.
    dialog.addEventListener('click', (ev) => {
      if (ev.target === dialog) dialog.close();
    });
  }
}
