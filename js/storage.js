/**
 * localStorage — apenas o que é pequeno e síncrono.
 *
 * Livro e cache de tradução ficam no IndexedDB (db.js): localStorage tem ~5MB
 * e bloqueia a thread principal.
 */

import { notify } from './notifications.js';

const KEYS = {
  prefs: 'epub_preferences',
  progress: 'epub_progress',
  bookmarks: 'epub_bookmarks',
  readingMark: 'epub_reading_mark',
};

export const DEFAULT_PREFS = {
  fontSize: null,        // null: padrão do aparelho (19px, 18px no celular)
  lineHeight: 1.7,
  theme: 'system',       // 'light' | 'dark' | 'system'
  targetLang: 'pt-BR',
  viewMode: 'split',     // 'original' | 'translated' | 'split'
  fontFamily: 'serif',   // 'serif' | 'sans'
  markColor: 'amber',    // cor do marcador "parei aqui"
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return structuredClone(fallback);
    return JSON.parse(raw);
  } catch {
    // JSON corrompido não deve impedir o app de abrir.
    return structuredClone(fallback);
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    notify.error('storage-failed', 'Falha ao salvar preferências', String(err?.message || err));
    return false;
  }
}

/* ---------------------------------- prefs --------------------------------- */

export function getPrefs() {
  return { ...DEFAULT_PREFS, ...read(KEYS.prefs, {}) };
}

export function setPrefs(patch) {
  const next = { ...getPrefs(), ...patch };
  write(KEYS.prefs, next);
  return next;
}

/* -------------------------------- progresso -------------------------------- */

export function getProgress(bookId) {
  return read(KEYS.progress, {})[bookId] || null;
}

export function setProgress(bookId, { chapterIndex, scrollRatio }) {
  const all = read(KEYS.progress, {});
  all[bookId] = { chapterIndex, scrollRatio, updatedAt: Date.now() };
  write(KEYS.progress, all);
}

export function removeProgress(bookId) {
  const all = read(KEYS.progress, {});
  delete all[bookId];
  write(KEYS.progress, all);
}

/* ------------------------------ progresso em % ------------------------------ */

/**
 * Fração do livro já lida, por volume de texto.
 *
 * Capítulos anteriores contam inteiros; o atual entra proporcional à rolagem.
 * Sem `chapterLengths` (livro importado antes da medição existir) cai no
 * método por contagem de capítulos, que é impreciso mas melhor que nada — o
 * chamador pode sinalizar isso como aproximado.
 *
 * @returns {{ratio: number, exact: boolean}}
 */
export function computeProgress(chapterLengths, chapterCount, chapterIndex, scrollRatio = 0) {
  if (!Array.isArray(chapterLengths) || !chapterLengths.length) {
    const total = chapterCount || 1;
    return { ratio: Math.min(1, (chapterIndex + 1) / total), exact: false };
  }

  const total = chapterLengths.reduce((sum, n) => sum + n, 0);
  if (!total) return { ratio: 0, exact: true };

  let before = 0;
  for (let i = 0; i < chapterIndex && i < chapterLengths.length; i++) {
    before += chapterLengths[i];
  }

  const current = chapterLengths[chapterIndex] || 0;
  return { ratio: Math.min(1, (before + current * scrollRatio) / total), exact: true };
}

/* ----------------------------- marcador de linha ---------------------------- */

/**
 * O "parei aqui": um por livro, ancorado no parágrafo.
 *
 * Guarda o hash do texto E o índice do bloco. O hash é o que torna o marcador
 * robusto — muda a fonte, a largura ou o modo de leitura e ele continua na
 * mesma frase, coisa que a proporção de rolagem não garante. O índice entra
 * como desempate quando o mesmo texto se repete no capítulo.
 */
export function getReadingMark(bookId) {
  return read(KEYS.readingMark, {})[bookId] || null;
}

export function setReadingMark(bookId, mark) {
  const all = read(KEYS.readingMark, {});
  // Copiar o objeto inteiro: desestruturar campo a campo já custou o descarte
  // silencioso de side/start/end, deixando toda seleção virar parágrafo.
  all[bookId] = { ...mark, updatedAt: Date.now() };
  write(KEYS.readingMark, all);
  return all[bookId];
}

export function clearReadingMark(bookId) {
  const all = read(KEYS.readingMark, {});
  delete all[bookId];
  write(KEYS.readingMark, all);
}

/* -------------------------------- bookmarks -------------------------------- */

export function getBookmarks(bookId) {
  return read(KEYS.bookmarks, {})[bookId] || [];
}

/**
 * Trecho salvo. Ancorado no parágrafo (hash + índice) como o "parei aqui";
 * scrollRatio fica só como último recurso se o parágrafo sumir.
 */
export function addBookmark(bookId, { chapterIndex, chapterTitle, blockIndex, hash, scrollRatio, excerpt }) {
  const all = read(KEYS.bookmarks, {});
  const list = all[bookId] || [];

  // Salvar o mesmo parágrafo duas vezes não cria duplicata.
  if (list.some((b) => b.chapterIndex === chapterIndex && b.hash === hash)) return list;

  list.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    chapterIndex,
    chapterTitle,
    blockIndex,
    hash,
    scrollRatio,
    excerpt,
    createdAt: Date.now(),
  });
  all[bookId] = list;
  write(KEYS.bookmarks, all);
  return list;
}

export function removeBookmark(bookId, bookmarkId) {
  const all = read(KEYS.bookmarks, {});
  all[bookId] = (all[bookId] || []).filter((b) => b.id !== bookmarkId);
  write(KEYS.bookmarks, all);
  return all[bookId];
}

export function removeBookmarks(bookId) {
  const all = read(KEYS.bookmarks, {});
  delete all[bookId];
  write(KEYS.bookmarks, all);
}
