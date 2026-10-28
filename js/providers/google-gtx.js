/**
 * Provider padrão: endpoint gtx do Google Tradutor.
 *
 * Sem chave e com CORS liberado. Dois detalhes descobertos testando o endpoint
 * e dos quais o resto do código depende:
 *
 *  1. O `\n` SOBREVIVE à tradução. É isso que permite mandar N parágrafos num
 *     request e re-parear 1:1 no retorno.
 *  2. O array `sentences` divide por FRASE, não por parágrafo. Só concatenar
 *     tudo e dar split('\n') devolve o pareamento correto.
 *
 * Contrapartida: é endpoint não-oficial. Pode passar a limitar sem aviso — daí
 * o fallback em translator.js.
 */

import { fetchText } from './http.js';

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function request(params, body, signal) {
  const url = `${ENDPOINT}?${new URLSearchParams(params)}`;

  let res;
  let text;
  try {
    ({ res, body: text } = await fetchText(url, {
      method: 'POST',
      // form-urlencoded é CORS-safelisted: não dispara preflight.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams(body).toString(),
    }, { signal }));
  } catch (err) {
    if (err.message === 'ABORTED' || err.code === 'timeout') throw err;
    // Ao limitar, o endpoint redireciona para a página anti-abuso do Google,
    // que não traz cabeçalho CORS — o navegador entrega isso como uma falha de
    // rede genérica. Dizer "sem internet" aqui seria enganoso.
    throw navigator.onLine
      ? fail('ratelimit',
          'O serviço recusou a requisição (provável limite de uso). ' +
          'Costuma liberar sozinho em alguns minutos.')
      : fail('network', `Falha de rede: ${err.message}`);
  }

  if (res.status === 429) throw fail('ratelimit', 'HTTP 429 — limite de requisições');
  if (res.status >= 500) throw fail('server', `HTTP ${res.status} no serviço de tradução`);
  if (!res.ok) throw fail('http', `HTTP ${res.status} no serviço de tradução`);

  try {
    return JSON.parse(text);
  } catch {
    throw fail('parse', 'Resposta ilegível do serviço de tradução');
  }
}

export const googleGtx = {
  id: 'google-gtx',
  name: 'Google Tradutor',
  supportsDictionary: true,
  /** Acima disso o endpoint fica instável; translator.js fatia antes de chamar. */
  maxChunkChars: 4000,

  /**
   * @param {string[]} texts  parágrafos SEM quebras internas (o chamador normaliza)
   * @param {{ signal?: AbortSignal }} opts  cancela o pedido em andamento
   * @returns {Promise<string[]>} mesma quantidade, na mesma ordem
   */
  async translateBatch(texts, targetLang, sourceLang = 'auto', { signal } = {}) {
    const data = await request(
      { client: 'gtx', sl: sourceLang, tl: targetLang, dt: 't', dj: '1' },
      { q: texts.join('\n') },
      signal
    );

    const sentences = data?.sentences;
    if (!Array.isArray(sentences)) throw fail('parse', 'Resposta sem o campo "sentences"');

    const lines = sentences.map((s) => s.trans || '').join('').split('\n');

    if (lines.length !== texts.length) {
      // Guarda crítica: sem ela um desalinhamento silencioso embaralha o livro.
      throw fail('misaligned', `Esperados ${texts.length} parágrafos, vieram ${lines.length}`);
    }

    return lines;
  },

  /** Verbete completo: classe gramatical + sentidos + traduções reversas. */
  async lookupWord(word, targetLang, sourceLang = 'auto') {
    const data = await request(
      { client: 'gtx', sl: sourceLang, tl: targetLang, dt: 't', dj: '1' },
      { q: word, dt: 'bd' }
    );

    const translation = (data?.sentences || []).map((s) => s.trans || '').join('').trim();

    const entries = (data?.dict || []).map((d) => ({
      pos: d.pos || '',
      terms: (d.terms || []).slice(0, 8),
      meanings: (d.entry || []).slice(0, 4).map((e) => ({
        word: e.word,
        reverse: (e.reverse_translation || []).slice(0, 5),
      })),
    }));

    return { word, translation, entries, detectedSource: data?.src || sourceLang };
  },
};
