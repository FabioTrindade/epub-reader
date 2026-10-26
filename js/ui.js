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

/* ---------------------------------- menus ---------------------------------- */

/**
 * Menu suspenso ancorado a um botão (⋯, "Traduzindo N%").
 *
 * Fecha ao escolher um item, com Esc ou com clique fora — o mesmo contrato
 * de um menu nativo, sem o peso de um <dialog> modal.
 */
export class PopoverMenu {
  constructor(trigger, menu) {
    this.trigger = trigger;
    this.menu = menu;

    trigger.addEventListener('click', () => (menu.hidden ? this.open() : this.close()));
    menu.addEventListener('click', (ev) => {
      if (ev.target.closest('[role="menuitem"]')) this.close();
    });
    document.addEventListener('pointerdown', (ev) => {
      if (!menu.hidden && !menu.contains(ev.target) && !trigger.contains(ev.target)) this.close();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !menu.hidden) {
        this.close();
        trigger.focus();
      }
    });
    window.addEventListener('resize', () => this.close());
  }

  open() {
    const rect = this.trigger.getBoundingClientRect();
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
    this.trigger.setAttribute('aria-expanded', 'false');
  }
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
