/**
 * Orquestra a tradução: cache → chunking → provider → guarda de alinhamento.
 *
 * O pipeline existe porque traduzir parágrafo a parágrafo seria lento demais
 * (um request por parágrafo) e traduzir o capítulo inteiro de uma vez perderia
 * a correspondência necessária para o modo lado-a-lado. O meio-termo: juntar
 * parágrafos com \n até ~4000 chars, um request, e re-parear no retorno.
 */

import { notify } from './notifications.js';
import * as db from './db.js';
import { googleGtx } from './providers/google-gtx.js';
import { myMemory } from './providers/mymemory.js';

const PROVIDERS = [googleGtx, myMemory];
const MAX_RETRIES = 3;
const CONCURRENCY = 2;

/** Hash estável do texto (djb2) — chave do cache. */
export function hashText(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Parágrafos não podem conter \n: é o separador do batch. */
export const normalize = (text) => text.replace(/\s+/g, ' ').trim();

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('ABORTED')); }, { once: true });
  });

export class Translator {
  #providerIndex = 0;
  #consecutiveFailures = 0;
  /**
   * Um chunk já esgotou todas as tentativas em todos os providers: os demais
   * desistem sem pedir nada. Insistir só repetiria a espera (até 10 s por
   * pedido) em serviços que não respondem, chunk após chunk.
   */
  #exhausted = false;

  constructor({ bookId, targetLang, sourceLang = 'auto' }) {
    this.bookId = bookId;
    this.targetLang = targetLang;
    this.sourceLang = sourceLang;
  }

  get provider() { return PROVIDERS[this.#providerIndex]; }

  /** Volta ao provider preferido — chamado ao abrir um capítulo novo. */
  resetProvider() {
    this.#providerIndex = 0;
    this.#consecutiveFailures = 0;
    this.#exhausted = false;
  }

  #demoteProvider(reason) {
    if (this.#providerIndex >= PROVIDERS.length - 1) return false;
    const from = this.provider.name;
    this.#providerIndex += 1;
    this.#consecutiveFailures = 0;
    notify.warn('provider-fallback', 'Trocando de serviço de tradução',
      `${from} → ${this.provider.name}. Motivo: ${reason}`);
    return true;
  }

  /**
   * Traduz os textos dados, usando cache quando possível.
   *
   * @param {string[]} texts
   * @param {{ onProgress?: (done:number, total:number)=>void, signal?: AbortSignal }} opts
   * @returns {Promise<Map<string,string>>} hash → tradução
   */
  async translate(texts, { onProgress, signal } = {}) {
    const results = new Map();

    // Parágrafos repetidos (títulos correntes, refrões) traduzem uma vez só.
    const unique = new Map();
    for (const raw of texts) {
      const text = normalize(raw);
      if (!text) continue;
      const hash = hashText(text);
      if (!unique.has(hash)) unique.set(hash, text);
    }

    if (!unique.size) return results;

    const cached = await db.getTranslations(this.bookId, this.targetLang, [...unique.keys()]);
    for (const [hash, text] of cached) results.set(hash, text);

    const pending = [...unique.entries()].filter(([hash]) => !results.has(hash));
    const total = unique.size;
    let done = results.size;
    onProgress?.(done, total);

    if (!pending.length) return results;

    if (!navigator.onLine) {
      notify.error('offline', 'Sem conexão',
        'A tradução precisa de internet. O texto original continua disponível.');
      throw new Error('OFFLINE');
    }

    const chunks = this.#buildChunks(pending);
    const fresh = [];

    // Fila com concorrência limitada: paralelismo demais provoca o 429.
    let cursor = 0;
    const worker = async () => {
      while (cursor < chunks.length) {
        if (signal?.aborted) throw new Error('ABORTED');
        const chunk = chunks[cursor++];
        const translated = await this.#translateChunk(chunk, signal);
        for (const [hash, text] of translated) {
          results.set(hash, text);
          // Falha (null) não vai para o cache: senão o parágrafo passaria a
          // contar como traduzido e nunca mais seria tentado.
          if (text) fresh.push({ hash, text });
        }
        done += chunk.length;
        onProgress?.(Math.min(done, total), total);
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
    } finally {
      // Grava o que deu certo mesmo se algo falhou: cache parcial ainda economiza.
      if (fresh.length) await db.putTranslations(this.bookId, this.targetLang, fresh);
    }

    return results;
  }

  /** Agrupa parágrafos até o limite do provider. */
  #buildChunks(pending) {
    const limit = this.provider.maxChunkChars;
    const chunks = [];
    let current = [];
    let size = 0;

    for (const entry of pending) {
      const len = entry[1].length + 1;
      if (current.length && size + len > limit) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(entry);
      size += len;
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  /**
   * Traduz um chunk com retry, backoff e degradação.
   * @param {Array<[string,string]>} chunk pares [hash, texto]
   */
  async #translateChunk(chunk, signal) {
    const texts = chunk.map(([, text]) => text);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) throw new Error('ABORTED');
      if (this.#exhausted) return chunk.map(([hash]) => [hash, null]);

      try {
        const translated = await this.provider.translateBatch(texts, this.targetLang, this.sourceLang, { signal });
        this.#consecutiveFailures = 0;
        return chunk.map(([hash], i) => [hash, translated[i]]);
      } catch (err) {
        if (err.message === 'ABORTED') throw err;

        // Desalinhamento não se resolve repetindo: traduz um a um e pronto.
        if (err.code === 'misaligned') {
          notify.warn('translate-misaligned', 'Tradução re-alinhada parágrafo a parágrafo',
            `${err.message}. O capítulo continua correto, porém mais lento.`);
          return this.#translateIndividually(chunk, signal);
        }

        if (err.code === 'ratelimit') {
          notify.warn('translate-ratelimited', 'Limite de requisições atingido',
            `${this.provider.name}: aguardando para tentar de novo.`);
        }

        this.#consecutiveFailures++;

        const isLastAttempt = attempt === MAX_RETRIES;
        if (isLastAttempt || this.#consecutiveFailures >= 2) {
          if (this.#demoteProvider(err.message)) {
            attempt = -1; // recomeça as tentativas com o novo provider
            continue;
          }
          if (isLastAttempt) {
            this.#exhausted = true;
            notify.error('translate-failed', 'Falha ao traduzir',
              `${err.message.replace(/\.$/, '')}. Os parágrafos afetados seguem no original.`);
            return chunk.map(([hash]) => [hash, null]);
          }
        }

        await sleep(500 * 2 ** attempt, signal); // backoff exponencial
      }
    }

    return chunk.map(([hash]) => [hash, null]);
  }

  /** Caminho degradado: um request por parágrafo, imune a desalinhamento. */
  async #translateIndividually(chunk, signal) {
    const out = [];
    for (const [hash, text] of chunk) {
      if (signal?.aborted) throw new Error('ABORTED');
      try {
        const [translated] = await this.provider.translateBatch([text], this.targetLang, this.sourceLang, { signal });
        out.push([hash, translated]);
      } catch (err) {
        // Cancelar não é falha do parágrafo: interrompe o capítulo inteiro.
        if (err.message === 'ABORTED') throw err;
        out.push([hash, null]);
      }
    }
    return out;
  }

  /** Verbete de dicionário, com cache próprio (vocabulário se repete muito). */
  async lookupWord(word) {
    const key = word.toLowerCase();

    const cached = await db.getWord(key, this.targetLang);
    if (cached) return cached;

    const provider = PROVIDERS.find((p) => p.supportsDictionary) || this.provider;
    const entry = await provider.lookupWord(key, this.targetLang, this.sourceLang);
    await db.putWord(key, this.targetLang, entry);
    return entry;
  }
}
