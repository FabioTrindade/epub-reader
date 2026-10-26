/**
 * Ponto de entrada: liga os módulos e o DOM.
 */

import { notify } from './notifications.js';
import { parseEpub, hashBook, measureChapters } from './epub-parser.js';
import { Reader } from './reader.js';
import * as storage from './storage.js';
import * as db from './db.js';
import {
  $, applyPrefs, toast, wireDialogs,
  NotificationUI, SidebarUI, LibraryUI, SettingsUI, PopoverMenu,
} from './ui.js';

const MOBILE = window.matchMedia('(max-width: 768px)');

let reader;
let sidebar;
let library;
let settings;
let currentBook = null;

/* ------------------------------- inicialização ------------------------------ */

function init() {
  const prefs = storage.getPrefs();
  applyPrefs(prefs);

  wireDialogs();
  new NotificationUI();
  new PopoverMenu($('#btn-more'), $('#menu-more'));
  new PopoverMenu($('#translate-status'), $('#menu-translate'));

  reader = new Reader($('#viewport'));
  sidebar = new SidebarUI(
    (index) => reader.loadChapter(index),
    (bm) => reader.goToBookmark(bm),
    (id) => {
      sidebar.renderBookmarks(storage.removeBookmark(currentBook.id, id));
      reader.refreshBookmarks();
    }
  );
  library = new LibraryUI(openFromLibrary, deleteBook);
  settings = new SettingsUI(onPrefChange, clearTranslationCache);
  settings.sync(prefs);

  wireFileInput();
  wireReaderEvents();
  wireNavigation();
  wireViewModes(prefs.viewMode);

  library.render();
  restoreLastBook();
}

/* --------------------------------- abertura -------------------------------- */

function wireFileInput() {
  $('#file-input').addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    if (file) handleFile(file);
    ev.target.value = ''; // permite reabrir o mesmo arquivo
  });

  const zone = $('#drop-zone');
  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (ev) => { ev.preventDefault(); zone.classList.add('is-over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, () => zone.classList.remove('is-over'));
  }
  zone.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const file = ev.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
}

async function handleFile(file) {
  if (!/\.epub$/i.test(file.name) && file.type !== 'application/epub+zip') {
    notify.error('parse-failed', 'Formato não suportado', `${file.name} não é um arquivo EPUB.`);
    return;
  }

  setBusy(true);
  try {
    const buffer = await file.arrayBuffer();
    const id = await hashBook(buffer, file);

    const existing = await db.getBook(id);
    if (existing) {
      // Livro já conhecido: reabre sem regravar os megabytes.
      await openBook(existing.id, existing.file);
      return;
    }

    const parsed = await parseEpub(buffer, file);

    // Medir agora: o zip já está aberto e o usuário já está esperando. Custa
    // dezenas de ms e é o que torna o percentual da biblioteca honesto.
    const chapterLengths = await measureChapters(parsed);

    await db.putBook({
      id,
      title: parsed.title,
      author: parsed.author,
      lang: parsed.lang,
      file: buffer,
      cover: parsed.cover,
      chapterCount: parsed.chapters.length,
      chapterLengths,
      tocPositions: tocPositions(parsed),
      addedAt: Date.now(),
      lastOpenedAt: Date.now(),
    });

    await startReading(id, parsed);
    library.render();
  } catch (err) {
    if (err.message !== 'DRM_PROTECTED') {
      notify.error('parse-failed', 'Não foi possível ler o EPUB', String(err.message || err));
    }
  } finally {
    setBusy(false);
  }
}

async function openBook(id, buffer) {
  setBusy(true);
  try {
    const parsed = await parseEpub(buffer, null);
    await startReading(id, parsed);
  } catch (err) {
    notify.error('parse-failed', 'Não foi possível abrir o livro', String(err.message || err));
  } finally {
    setBusy(false);
  }
}

async function openFromLibrary(id) {
  const record = await db.getBook(id);
  if (!record) return;
  await openBook(id, record.file);
}

async function startReading(id, parsed) {
  currentBook = { id, ...parsed };

  $('#welcome').hidden = true;
  $('#book-title').textContent = parsed.title;
  renderSubtitle();
  document.title = `${parsed.title} — EPUB Reader`;

  sidebar.renderToc(parsed.chapters);
  sidebar.renderBookmarks(storage.getBookmarks(id));

  // O "parei aqui" tem prioridade sobre a rolagem salva: é uma escolha
  // explícita do leitor, e ancorada no parágrafo, não na altura da página.
  const mark = storage.getReadingMark(id);
  const progress = storage.getProgress(id);

  await reader.open(currentBook, {
    chapterIndex: mark?.chapterIndex ?? progress?.chapterIndex ?? 0,
    scrollRatio: progress?.scrollRatio ?? 0,
    anchor: mark,
  });

  if (mark) toast('info', 'Retomando de onde você parou', mark.excerpt);

  backfillBookRecord(id, parsed);
}

/** Item da lateral de cada capítulo: a biblioteca conta por ele sem reabrir o livro. */
function tocPositions(parsed) {
  return parsed.chapters.map((ch) => ch.tocPosition);
}

/**
 * Livros importados antes da medição ou do mapa do sumário existirem não têm
 * chapterLengths / tocPositions. Preencher em segundo plano, depois que o
 * capítulo já apareceu, evita atrasar a abertura.
 */
async function backfillBookRecord(id, parsed) {
  const record = await db.getBook(id);
  if (!record) return;

  const patch = {};
  if (record.tocPositions?.length !== parsed.chapters.length) {
    patch.tocPositions = tocPositions(parsed);
  }

  if (!record.chapterLengths?.length) {
    try {
      patch.chapterLengths = await measureChapters(parsed);
    } catch {
      // Sem a medição o percentual apenas continua aproximado.
    }
  }

  // updateBook, não putBook: gravar o registro lido acima desfaria o
  // lastOpenedAt que o touchBook da abertura gravou nesse meio-tempo.
  if (Object.keys(patch).length) await db.updateBook(id, patch);
}

async function restoreLastBook() {
  const books = await db.listBooks();
  const last = books[0];
  if (last?.lastOpenedAt) await openBook(last.id, last.file);
}

async function deleteBook(book) {
  if (!confirm(`Remover "${book.title}" e seus dados de leitura?`)) return;

  await db.deleteBook(book.id);
  await db.clearTranslations(book.id);
  storage.removeProgress(book.id);
  storage.removeBookmarks(book.id);
  storage.clearReadingMark(book.id);

  if (currentBook?.id === book.id) {
    reader.close();
    currentBook = null;
    $('#welcome').hidden = false;
    $('#book-title').textContent = 'EPUB Reader';
    renderSubtitle();
    $('#chapter-label').textContent = '—';
    sidebar.renderToc([]);
  }

  library.render();
  toast('info', 'Livro removido', book.title);
}

/* ---------------------------------- eventos --------------------------------- */

function wireReaderEvents() {
  reader.addEventListener('chapter-loaded', (ev) => {
    const { chapter, index } = ev.detail;
    const total = currentBook.chapters.length;
    // O contador segue a lateral; as setas seguem os capítulos internos.
    const position = chapter.tocPosition + 1;
    $('#chapter-label').textContent =
      `${chapter.title || `Capítulo ${position}`} · ${position}/${currentBook.tocCount}`;
    renderSubtitle(chapter.title || `Capítulo ${position}`);
    sidebar.highlight(index);
    $('#btn-prev').disabled = index === 0;
    $('#btn-next').disabled = index === total - 1;
    updateReadingProgress(0);
    updateGotoMark();
    updateMarkButton();
  });

  reader.addEventListener('mark-changed', () => {
    updateGotoMark();
    updateMarkButton();
  });

  reader.addEventListener('chapter-error', () => {
    $('#chapter-label').textContent = 'Capítulo indisponível';
  });

  reader.addEventListener('scroll', (ev) => {
    updateReadingProgress(ev.detail.ratio);
    updateGotoMark();
    scheduleMarkButtonUpdate();
  });

  // selectionchange dispara muito durante o arrasto: uma atualização por frame.
  let markBtnFrame = null;
  function scheduleMarkButtonUpdate() {
    if (markBtnFrame) return;
    markBtnFrame = requestAnimationFrame(() => {
      markBtnFrame = null;
      updateMarkButton();
    });
  }
  document.addEventListener('selectionchange', scheduleMarkButtonUpdate);

  reader.addEventListener('translate-start', () => showTranslating(0));

  reader.addEventListener('translate-progress', (ev) => {
    const { done, total } = ev.detail;
    showTranslating(done / total);
  });

  for (const type of ['translate-done', 'translate-error', 'translate-cancelled']) {
    reader.addEventListener(type, hideTranslating);
  }

  $('#btn-cancel-translate').addEventListener('click', () => {
    // Abortar de fato: só trocar o modo deixaria os requests correndo.
    reader.cancelTranslation();
    setViewMode('original');
    hideTranslating();
  });
}

/**
 * Tradução em andamento: linha fina sob o topo, "Traduzindo N%" ao lado do Aa
 * e esqueletos nos parágrafos que ainda faltam (classe no body).
 */
function showTranslating(ratio) {
  const percent = Math.round(ratio * 100);
  document.body.classList.add('is-translating');
  $('#translate-status').hidden = false;
  $('#translate-line').hidden = false;
  $('#translate-label').textContent = `Traduzindo ${percent}%`;
  $('#translate-progress').style.width = `${percent}%`;
}

function hideTranslating() {
  document.body.classList.remove('is-translating');
  $('#translate-status').hidden = true;
  $('#translate-line').hidden = true;
  $('#menu-translate').hidden = true;
}

/** "Autor · capítulo" sob o título; no celular só o capítulo cabe. */
function renderSubtitle(chapterTitle = '') {
  const el = $('#book-subtitle');
  const author = document.createElement('span');
  author.className = 'subtitle-author';
  author.textContent = currentBook?.author || '';
  const chapter = document.createElement('span');
  chapter.className = 'subtitle-chapter';
  chapter.textContent = chapterTitle;
  el.replaceChildren(author, chapter);
}

function updateReadingProgress(ratio) {
  $('#reading-progress').style.width = `${Math.round(ratio * 100)}%`;
}

function wireNavigation() {
  $('#btn-prev').addEventListener('click', () => reader.previous());
  $('#btn-next').addEventListener('click', () => reader.next());
  $('#btn-library').addEventListener('click', showLibrary);
  $('#btn-back').addEventListener('click', showLibrary);
  $('#btn-bookmark').addEventListener('click', addBookmark);
  $('#btn-mark').addEventListener('click', markLine);

  // Sem isto o mousedown move o foco e desfaz a seleção ANTES do click rodar —
  // o botão receberia uma seleção vazia e marcaria o parágrafo errado.
  for (const sel of ['#btn-mark', '#btn-bookmark']) {
    $(sel).addEventListener('mousedown', (ev) => ev.preventDefault());
  }
  $('#btn-goto-mark').addEventListener('click', () => reader.goToMark());

  document.addEventListener('keydown', (ev) => {
    // ev.target pode ser o próprio document (sem elemento focado), que não tem
    // .matches — sem esta guarda, todos os atalhos quebram nesse estado.
    const el = ev.target instanceof Element ? ev.target : null;
    if (el?.matches('input, textarea, select') || document.querySelector('dialog[open]')) return;
    if (ev.key === 'ArrowRight') reader.next();
    else if (ev.key === 'ArrowLeft') reader.previous();
    else if (ev.key === 'b') addBookmark();
    else if (ev.key === 'm') markLine();
  });
}

/* ------------------------------ marcador de linha --------------------------- */

/** Há texto selecionado dentro da área de leitura? */
function hasTextSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return false;
  const node = sel.anchorNode;
  const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return Boolean(el && $('#viewport').contains(el));
}

/** Sem seleção e com o marcador já à vista, o botão vira "remover". */
function markButtonRemoves() {
  return Boolean(currentBook) && !hasTextSelection() && reader.hasMark && reader.isMarkVisible();
}

function markLine() {
  if (!currentBook) return;

  // Marcar limpa a seleção, então um segundo clique não teria mais o que
  // marcar e moveria a marca para o topo — apagando o que você acabou de
  // fazer. Com o marcador à vista, o botão remove em vez de mover.
  if (markButtonRemoves()) {
    reader.clearMark();
    toast('info', 'Marcador removido', 'Selecione um trecho e clique para marcar de novo.');
    updateMarkButton();
    return;
  }

  const mark = reader.mark();
  if (!mark) {
    toast('info', 'Nada para marcar', 'Esta página não tem parágrafos de texto.');
    return;
  }

  if (mark.start != null) {
    toast('info', 'Parei aqui', `“${mark.excerpt}”`);
  } else {
    // Sem seleção marcamos o parágrafo do topo; dizer isso evita a impressão
    // de que o botão marcou no lugar errado.
    toast('info', 'Parei aqui — parágrafo do topo',
      'Selecione um trecho antes de clicar para marcar só ele.');
  }
  updateMarkButton();
}

/** O rótulo do botão diz o que o próximo clique fará. */
function updateMarkButton() {
  const btn = $('#btn-mark');
  if (!btn) return;

  const removing = markButtonRemoves();
  btn.classList.toggle('is-remove', removing);
  btn.querySelector('.icon-mark').hidden = removing;
  btn.querySelector('.icon-unmark').hidden = !removing;
  btn.querySelector('.btn-label').textContent = removing ? 'Remover marca' : 'Parei aqui';
  btn.setAttribute('aria-label', removing
    ? 'Remover o marcador'
    : 'Parei aqui: marcar o trecho selecionado');
  btn.title = removing
    ? 'Remover o marcador (M)'
    : 'Parei aqui — selecione um trecho e clique. Sem seleção, marca o parágrafo do topo. (M)';
}

/** O atalho só aparece quando o marcador existe e está fora de vista. */
function updateGotoMark() {
  const mark = currentBook ? storage.getReadingMark(currentBook.id) : null;
  const libraryOpen = !$('#welcome').hidden;
  $('#btn-goto-mark').hidden = !mark || libraryOpen || reader.isMarkVisible();
}

function showLibrary() {
  $('#welcome').hidden = false;
  library.render();
  updateGotoMark();
}

function addBookmark() {
  if (!currentBook || !reader.chapter) return;

  const anchor = reader.currentAnchor();
  if (!anchor) {
    toast('info', 'Nada para salvar', 'Esta página não tem parágrafos de texto.');
    return;
  }

  const before = storage.getBookmarks(currentBook.id).length;
  const list = storage.addBookmark(currentBook.id, { ...anchor, scrollRatio: reader.scrollRatio });

  sidebar.renderBookmarks(list);
  reader.refreshBookmarks();

  // storage recusa duplicatas; avisar "salvo" nesse caso seria mentira.
  if (list.length === before) toast('info', 'Este trecho já estava salvo', anchor.excerpt);
  else toast('info', 'Trecho salvo', anchor.excerpt);
}

/* -------------------------------- modos de vista ---------------------------- */

function wireViewModes(initial) {
  for (const btn of document.querySelectorAll('#mode-switch button')) {
    btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
  }
  for (const btn of document.querySelectorAll('#mobile-tabs button')) {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mobileMode;
      // Com "split" salvo, a aba só troca a vista e o desktop continua lado a
      // lado. Fora dele, a aba faz o papel do seletor do topo: grava o modo.
      if (storage.getPrefs().viewMode === 'split') {
        selectMobileTab(mode);
        reader.applyViewMode(mode);
      } else {
        setViewMode(mode);
      }
    });
  }

  MOBILE.addEventListener('change', () => syncMobileTabs(storage.getPrefs().viewMode));
  setViewMode(initial);
}

function selectMobileTab(mode) {
  for (const btn of document.querySelectorAll('#mobile-tabs button')) {
    const active = btn.dataset.mobileMode === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
}

/**
 * No celular o lado-a-lado não cabe, e o seletor do topo tiraria o espaço do
 * título: os modos viram as abas Original/Tradução. Com a preferência em
 * "split", a aba lembra a última escolha e o desktop continua lado a lado.
 */
function syncMobileTabs(mode) {
  $('#mobile-tabs').hidden = !MOBILE.matches;

  if (!MOBILE.matches) {
    reader.applyViewMode(mode);
    return;
  }

  if (mode !== 'split') selectMobileTab(mode);
  const active = document.querySelector('#mobile-tabs .is-active')?.dataset.mobileMode || 'original';
  reader.applyViewMode(active);
}

function setViewMode(mode) {
  storage.setPrefs({ viewMode: mode });
  for (const btn of document.querySelectorAll('#mode-switch button')) {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
  syncMobileTabs(mode);
}

/* ------------------------------- configurações ------------------------------ */

function onPrefChange(key) {
  // Trocar o idioma invalida o que está na tela: recarrega o capítulo.
  if (key === 'targetLang' && currentBook) {
    reader.loadChapter(reader.chapterIndex, { scrollRatio: reader.scrollRatio });
  }
}

async function clearTranslationCache() {
  if (!currentBook) {
    toast('info', 'Nenhum livro aberto', 'Abra um livro para limpar o cache dele.');
    return;
  }
  await db.clearTranslations(currentBook.id);
  toast('info', 'Cache limpo', 'As traduções serão buscadas de novo quando necessário.');
  reader.loadChapter(reader.chapterIndex, { scrollRatio: reader.scrollRatio });
}

/* ---------------------------------- auxiliar -------------------------------- */

function setBusy(busy) {
  document.body.classList.toggle('is-busy', busy);
}

init();
