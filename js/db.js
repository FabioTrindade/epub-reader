/**
 * IndexedDB — o que é grande ou assíncrono.
 *
 * Stores:
 *   books        { id, title, author, lang, file: ArrayBuffer, cover: Blob, ... }
 *   translations { key: `${bookId}|${lang}|${hash}`, text }
 *   words        { key: `${palavra}|${lang}`, entry }
 */

import { notify } from './notifications.js';

const DB_NAME = 'epub-reader';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) {
        db.createObjectStore('books', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('translations')) {
        db.createObjectStore('translations', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('words')) {
        db.createObjectStore('words', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const req = fn(transaction.objectStore(store));
        transaction.oncomplete = () => resolve(req?.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

/** QuotaExceededError é o erro que importa distinguir: o usuário precisa agir. */
function handleWriteError(err) {
  if (err?.name === 'QuotaExceededError') {
    notify.error(
      'quota-exceeded',
      'Espaço de armazenamento esgotado',
      'Remova livros ou limpe o cache de traduções nas configurações.'
    );
  } else {
    notify.error('storage-failed', 'Falha ao gravar no banco local', String(err?.message || err));
  }
  throw err;
}

/* ---------------------------------- books --------------------------------- */

export async function putBook(book) {
  try {
    return await tx('books', 'readwrite', (s) => s.put(book));
  } catch (err) {
    return handleWriteError(err);
  }
}

export function getBook(id) {
  return tx('books', 'readonly', (s) => s.get(id));
}

export function listBooks() {
  return tx('books', 'readonly', (s) => s.getAll()).then((books) =>
    (books || []).sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt))
  );
}

export function deleteBook(id) {
  return tx('books', 'readwrite', (s) => s.delete(id));
}

/**
 * Lê, altera e grava o livro numa transação só. Com getBook + putBook em
 * transações separadas, duas atualizações simultâneas (touchBook e o backfill
 * da abertura) liam o mesmo registro e a segunda apagava a escrita da primeira.
 */
export async function updateBook(id, patch) {
  try {
    return await tx('books', 'readwrite', (s) => {
      const req = s.get(id);
      req.onsuccess = () => {
        if (req.result) s.put({ ...req.result, ...patch });
      };
      return req;
    });
  } catch (err) {
    return handleWriteError(err);
  }
}

export function touchBook(id) {
  return updateBook(id, { lastOpenedAt: Date.now() });
}

/* ------------------------------- translations ------------------------------ */

const tKey = (bookId, lang, hash) => `${bookId}|${lang}|${hash}`;

/** Lê várias traduções numa transação só (uma por hash seria lento demais). */
export async function getTranslations(bookId, lang, hashes) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const out = new Map();
    const transaction = db.transaction('translations', 'readonly');
    const store = transaction.objectStore('translations');
    for (const hash of hashes) {
      const req = store.get(tKey(bookId, lang, hash));
      req.onsuccess = () => {
        if (req.result) out.set(hash, req.result.text);
      };
    }
    transaction.oncomplete = () => resolve(out);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function putTranslations(bookId, lang, entries) {
  if (!entries.length) return;
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('translations', 'readwrite');
      const store = transaction.objectStore('translations');
      for (const { hash, text } of entries) {
        store.put({ key: tKey(bookId, lang, hash), text });
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch (err) {
    return handleWriteError(err);
  }
}

/** Remove o cache de um livro (ou de todos, se bookId for omitido). */
export async function clearTranslations(bookId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('translations', 'readwrite');
    const store = transaction.objectStore('translations');
    if (!bookId) {
      store.clear();
    } else {
      const prefix = `${bookId}|`;
      const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
      const req = store.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/* ---------------------------------- words --------------------------------- */

export function getWord(word, lang) {
  return tx('words', 'readonly', (s) => s.get(`${word}|${lang}`)).then((r) => r?.entry || null);
}

export async function putWord(word, lang, entry) {
  try {
    return await tx('words', 'readwrite', (s) => s.put({ key: `${word}|${lang}`, entry }));
  } catch {
    // Cache de dicionário é conveniência: falhar aqui não deve interromper a leitura.
  }
}

/* --------------------------------- storage -------------------------------- */

export async function estimateUsage() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
