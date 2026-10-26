/**
 * Fallback: MyMemory (memória de tradução comunitária).
 *
 * Sem chave e com CORS liberado, mas com duas limitações que moldam o código:
 * traduz UM texto por request (não há batch) e tem cota diária por IP. Por isso
 * é fallback, não padrão — entra em cena quando o gtx falha.
 */

const ENDPOINT = 'https://api.mymemory.translated.net/get';

/** Limite prático da query string do serviço. */
const MAX_CHARS = 500;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** en-US → en; pt-BR fica como está (o serviço exige a região no alvo). */
const shortLang = (l) => l.split('-')[0];

async function translateOne(text, targetLang, sourceLang) {
  const source = sourceLang === 'auto' ? 'en' : shortLang(sourceLang);
  const url = `${ENDPOINT}?${new URLSearchParams({
    q: text,
    langpair: `${source}|${targetLang}`,
  })}`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw fail('network', `Falha de rede: ${err.message}`);
  }

  if (!res.ok && res.status !== 429) throw fail('http', `HTTP ${res.status} no MyMemory`);

  const data = await res.json();

  // A cota diária vem ora como 429, ora como 200 com o aviso embutido no
  // próprio texto traduzido — este segundo caso passaria como tradução válida.
  const translated = data?.responseData?.translatedText || '';
  if (res.status === 429 || data?.quotaFinished || /MYMEMORY WARNING/i.test(translated)) {
    throw fail('ratelimit',
      'Cota diária gratuita do MyMemory esgotada. Ela reinicia depois de algumas horas.');
  }
  if (data?.responseStatus && Number(data.responseStatus) !== 200) {
    throw fail('http', `MyMemory: ${data.responseDetails || data.responseStatus}`);
  }

  return translated || text;
}

/** Quebra textos longos em sentenças para caber no limite do serviço. */
function splitLong(text) {
  if (text.length <= MAX_CHARS) return [text];

  const parts = [];
  let current = '';
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if ((current + ' ' + sentence).trim().length > MAX_CHARS && current) {
      parts.push(current.trim());
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export const myMemory = {
  id: 'mymemory',
  name: 'MyMemory',
  supportsDictionary: false,
  maxChunkChars: MAX_CHARS,

  async translateBatch(texts, targetLang, sourceLang = 'auto') {
    const out = [];
    for (const text of texts) {
      const pieces = splitLong(text);
      const translated = [];
      for (const piece of pieces) {
        translated.push(await translateOne(piece, targetLang, sourceLang));
      }
      out.push(translated.join(' '));
    }
    return out;
  },

  async lookupWord(word, targetLang, sourceLang = 'auto') {
    const translation = await translateOne(word, targetLang, sourceLang);
    return { word, translation, entries: [], detectedSource: sourceLang };
  },
};
