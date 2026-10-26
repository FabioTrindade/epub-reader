/**
 * Ponto de entrada: liga os módulos e o DOM.
 */

import { notify } from './notifications.js';
import { parseEpub, hashBook, measureChapters } from './epub-parser.js';
import { Reader } from './reader.js';
import * as storage from './storage.js';
import * as db from './db.js';
import {
  $, applyPrefs, toast, wireDialogs, confirmDialog,
  NotificationUI, SidebarUI, LibraryUI, AppearanceUI, PopoverMenu,
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
  const notifications = new NotificationUI();
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
  library = new LibraryUI({
    onOpen: openFromLibrary,
    onContinue: continueReading,
    onDelete: deleteBook,
  });
  settings = new AppearanceUI({
    onChange: onPrefChange,
    onClearCache: clearTranslationCache,
    onCopyDiagnostic: () => notifications.copyDiagnostic(),
    onCancelTranslation: cancelTranslation,
  });
  settings.sync(prefs);

  wireFileInput();
  wireReaderEvents();
  wireNavigation();
  wireViewModes(prefs.viewMode);
  wireSelectionBar();

  library.render();
  restoreLastBook();
}

/* --------------------------------- abertura -------------------------------- */

function wireFileInput() {
  // Há vários campos (topo, card tracejado, estado vazio), e a biblioteca
  // recria os seus a cada desenho: um ouvinte só, no documento.
  document.addEventListener('change', (ev) => {
    if (!ev.target.matches?.('.epub-input')) return;
    const file = ev.target.files?.[0];
    if (file) handleFile(file);
    ev.target.value = ''; // permite reabrir o mesmo arquivo
  });

  // Arrastar um arquivo para qualquer lugar da janela. dragenter/dragleave
  // disparam a cada elemento cruzado, daí o contador.
  const overlay = $('#drop-overlay');
  const hasFiles = (ev) => [...(ev.dataTransfer?.types || [])].includes('Files');
  let depth = 0;
  document.addEventListener('dragenter', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    depth += 1;
    overlay.hidden = false;
  });
  document.addEventListener('dragover', (ev) => {
    if (hasFiles(ev)) ev.preventDefault();
  });
  document.addEventListener('dragleave', (ev) => {
    if (!hasFiles(ev)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  document.addEventListener('drop', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const file = ev.dataTransfer.files?.[0];
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
      await openBook(existing);
      return;
    }

    if (!$('#welcome').hidden) library.showImporting(file.name);
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

    await startReading(id, parsed, chapterLengths);
    library.render();
  } catch (err) {
    if (err.message !== 'DRM_PROTECTED') {
      notify.error('parse-failed', 'Não foi possível ler o EPUB', String(err.message || err));
    }
  } finally {
    setBusy(false);
  }
}

/** Abre um livro já guardado; `record` é o registro do IndexedDB. */
async function openBook(record) {
  setBusy(true);
  try {
    const parsed = await parseEpub(record.file, null);
    await startReading(record.id, parsed, record.chapterLengths);
  } catch (err) {
    notify.error('parse-failed', 'Não foi possível abrir o livro', String(err.message || err));
  } finally {
    setBusy(false);
  }
}

async function openFromLibrary(id) {
  // O livro aberto continua montado sob a biblioteca: voltar a ele não precisa
  // reabrir, e o leitor reencontra o capítulo e a rolagem como deixou.
  if (currentBook?.id === id) {
    hideLibrary();
    return;
  }
  const record = await db.getBook(id);
  if (!record) return;
  await openBook(record);
}

/** "Continuar de onde parei": abrir já leva ao "parei aqui"; no livro aberto, vai até ele. */
async function continueReading(id) {
  const reopening = currentBook?.id !== id;
  await openFromLibrary(id);
  if (!reopening) await reader.goToMark();
}

/** `chapterLengths` (medido na importação) é o que dá o "% do livro" do rodapé. */
async function startReading(id, parsed, chapterLengths = null) {
  currentBook = { id, ...parsed, chapterLengths };

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
      if (currentBook?.id === id) currentBook.chapterLengths = patch.chapterLengths;
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
  if (last?.lastOpenedAt) await openBook(last);
}

async function deleteBook(book) {
  const confirmed = await confirmDialog({
    title: 'Remover livro?',
    text: `“${book.title}” sai da biblioteca, junto com o progresso, as marcas e as traduções guardadas dele.`,
    action: 'Remover',
    destructive: true,
  });
  if (!confirmed) return;

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
    $('#chapter-label-short').textContent = '';
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
    renderSubtitle(chapter.title || `Capítulo ${chapter.tocPosition + 1}`);
    sidebar.highlight(index);
    $('#btn-prev').disabled = index === 0;
    $('#btn-next').disabled = index === total - 1;
    updateReadingProgress(0);
    updateGotoMark();
    updateMarkButton();
    renderChapterEmpty();
  });

  reader.addEventListener('mark-changed', () => {
    updateGotoMark();
    updateMarkButton();
  });

  reader.addEventListener('chapter-error', () => {
    $('#chapter-label').textContent = 'Capítulo indisponível';
    $('#chapter-label-short').textContent = 'Capítulo indisponível';
  });

  reader.addEventListener('scroll', (ev) => {
    updateReadingProgress(ev.detail.ratio);
    updateGotoMark();
    scheduleSelectionUi();
  });
  document.addEventListener('selectionchange', scheduleSelectionUi);

  reader.addEventListener('translate-start', () => showTranslating(0));

  reader.addEventListener('translate-progress', (ev) => {
    const { done, total } = ev.detail;
    showTranslating(done / total);
  });

  for (const type of ['translate-done', 'translate-error', 'translate-cancelled']) {
    reader.addEventListener(type, hideTranslating);
  }

  $('#btn-cancel-translate').addEventListener('click', cancelTranslation);
}

function cancelTranslation() {
  // Abortar de fato: só trocar o modo deixaria os requests correndo.
  reader.cancelTranslation();
  setViewMode('original');
  hideTranslating();
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

/**
 * Página sem nenhum parágrafo (a capa, uma ilustração): em vez de uma coluna
 * de tradução vazia, um aviso e o caminho para o texto. Fica dentro do
 * capítulo, então o CSS esconde no modo Original e a próxima carga apaga.
 */
function renderChapterEmpty() {
  const container = reader.container;
  if (!container || container.querySelector('.tr-row')) return;

  const index = reader.chapterIndex;
  const lengths = currentBook.chapterLengths;
  // Com a medição do livro dá para pular direto para o primeiro texto.
  const next = lengths ? lengths.findIndex((n, i) => i > index && n > 0) : index + 1;
  const beforeText = lengths ? !lengths.slice(0, index + 1).some((n) => n > 0) : index === 0;

  const note = document.createElement('div');
  note.className = 'chapter-empty';
  const text = document.createElement('p');
  text.textContent = 'Esta página não tem texto para traduzir.';
  note.append(text);

  if (next > 0 && next < currentBook.chapters.length) {
    const go = document.createElement('button');
    go.className = 'text-btn';
    go.textContent = beforeText ? 'Ir para o primeiro capítulo' : 'Ir para o próximo capítulo';
    go.addEventListener('click', () => reader.loadChapter(next));
    note.append(go);
  }
  // No topo: numa capa, a ilustração ocuparia a tela e esconderia o aviso.
  // Sem parágrafos, o cabeçalho "original | tradução" não tem o que rotular.
  container.querySelector('.columns-head')?.remove();
  container.prepend(note);
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

/**
 * Rodapé: "Capítulo 7 de 146 · 2% do livro" e a barra. O capítulo conta pela
 * lateral, como a biblioteca; o percentual, por volume de texto.
 */
function updateReadingProgress(scrollRatio) {
  const chapter = reader.chapter;
  if (!currentBook || !chapter) return;

  const position = chapter.tocPosition + 1;
  const { ratio, exact } = storage.computeProgress(
    currentBook.chapterLengths, currentBook.chapters.length, reader.chapterIndex, scrollRatio);
  // O "~" avisa que o livro ainda não foi medido (importado antes da medição).
  const percent = `${exact ? '' : '~'}${Math.round(ratio * 100)}%`;

  $('#chapter-label').textContent = `Capítulo ${position} de ${currentBook.tocCount} · ${percent} do livro`;
  $('#chapter-label-short').textContent = `Cap. ${position} de ${currentBook.tocCount} · ${percent}`;
  $('#reading-progress').style.width = `${ratio * 100}%`;
}

// selectionchange e scroll disparam muito: uma atualização por frame.
let selectionFrame = null;
function scheduleSelectionUi() {
  if (selectionFrame) return;
  selectionFrame = requestAnimationFrame(() => {
    selectionFrame = null;
    updateMarkButton();
    positionSelectionBar();
  });
}

function wireNavigation() {
  $('#btn-prev').addEventListener('click', () => reader.previous());
  $('#btn-next').addEventListener('click', () => reader.next());
  $('#btn-library').addEventListener('click', showLibrary);
  $('#btn-back').addEventListener('click', showLibrary);
  $('#btn-mark').addEventListener('click', markLine);

  // Sem isto o mousedown move o foco e desfaz a seleção ANTES do click rodar —
  // o botão receberia uma seleção vazia e marcaria o parágrafo errado.
  $('#btn-mark').addEventListener('mousedown', (ev) => ev.preventDefault());
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

  // Seleção que atravessa parágrafos não tem um texto único para ancorar:
  // marca o parágrafo onde ela começa, não o do topo da tela.
  const crossing = hasTextSelection() && !reader.selectionAnchor();
  const mark = crossing ? reader.markRow(selectionStartRow()) : reader.mark();
  if (crossing) window.getSelection()?.removeAllRanges();
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
  btn.setAttribute('aria-label', removing
    ? 'Remover marca'
    : 'Parei aqui: marcar o parágrafo do topo da tela');
  btn.title = removing
    ? 'Remover marca (M)'
    : 'Parei aqui — sem seleção, marca o parágrafo do topo. (M)';
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
  hideSelectionBar();
}

function hideLibrary() {
  $('#welcome').hidden = true;
  updateGotoMark();
}

function addBookmark() {
  if (!currentBook || !reader.chapter) return;

  // Com seleção, salva o parágrafo dela; sem, o do topo da tela.
  const selected = hasTextSelection()
    ? reader.selectionAnchor() || reader.rowAnchor(selectionStartRow())
    : null;
  const anchor = selected || reader.currentAnchor();
  if (selected) window.getSelection()?.removeAllRanges();
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

/* ------------------------------ barra de seleção ---------------------------- */

/*
 * Parei aqui / Salvar / Copiar junto do trecho selecionado.
 *
 * No toque, tocar num botão da barra pode desfazer a seleção antes de o clique
 * chegar. Por isso guardamos a última seleção válida e a restauramos na hora
 * de agir, e não escondemos a barra enquanto ela está sendo tocada.
 */
let lastSelection = null;
let pressingSelectionBar = false;

function wireSelectionBar() {
  const bar = $('#selection-bar');

  const act = (fn) => () => {
    restoreSelection();
    fn();
    hideSelectionBar();
  };
  $('#sel-mark').addEventListener('click', act(() => {
    if (!selectionTouchesMark()) return markLine();
    window.getSelection()?.removeAllRanges();
    reader.clearMark();
    toast('info', 'Marcador removido', 'Selecione um trecho e clique para marcar de novo.');
    updateMarkButton();
  }));
  $('#sel-save').addEventListener('click', act(addBookmark));
  $('#sel-copy').addEventListener('click', act(copySelection));

  bar.addEventListener('mousedown', (ev) => ev.preventDefault());
  bar.addEventListener('pointerdown', () => { pressingSelectionBar = true; });
  document.addEventListener('pointerdown', (ev) => {
    if (!bar.contains(ev.target)) pressingSelectionBar = false;
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || bar.hidden) return;
    window.getSelection()?.removeAllRanges();
    hideSelectionBar();
  });
  window.addEventListener('resize', scheduleSelectionUi);
}

function positionSelectionBar() {
  const bar = $('#selection-bar');
  if (!hasTextSelection() || document.querySelector('dialog[open]')) {
    if (!pressingSelectionBar) hideSelectionBar();
    return;
  }

  const range = window.getSelection().getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const view = $('#viewport').getBoundingClientRect();
  if (rect.bottom < view.top || rect.top > view.bottom) {
    bar.hidden = true;
    return;
  }

  lastSelection = range.cloneRange();
  bar.querySelector('.sel-mark-label').textContent =
    selectionTouchesMark() ? 'Remover marca' : 'Parei aqui';
  bar.hidden = false;

  const { width, height } = bar.getBoundingClientRect();
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
  // Acima da seleção, ou abaixo se não couber. No toque, direto abaixo: acima
  // fica o menu de copiar/colar do próprio sistema.
  let top = rect.top - height - 12;
  if (window.matchMedia('(pointer: coarse)').matches || top < view.top + 8) top = rect.bottom + 12;
  bar.style.left = `${left}px`;
  bar.style.top = `${top}px`;
}

function hideSelectionBar() {
  $('#selection-bar').hidden = true;
  pressingSelectionBar = false;
}

function restoreSelection() {
  const sel = window.getSelection();
  if (sel && sel.isCollapsed && lastSelection) {
    sel.removeAllRanges();
    sel.addRange(lastSelection);
  }
}

/** A seleção encosta no "parei aqui" atual? Então a ação é removê-lo. */
function selectionTouchesMark() {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return false;
  const range = sel.getRangeAt(0);
  return [...$('#viewport').querySelectorAll('mark.reading-mark, .tr-row.is-marked')]
    .some((el) => range.intersectsNode(el));
}

function selectionStartRow() {
  const node = window.getSelection()?.getRangeAt(0).startContainer;
  const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return el?.closest('.tr-row') || null;
}

async function copySelection() {
  const text = window.getSelection()?.toString().trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard bloqueado (contexto ou permissão): o comando antigo copia a seleção.
    document.execCommand('copy');
  }
  toast('info', 'Trecho copiado', text.length > 80 ? `${text.slice(0, 80)}…` : text);
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
