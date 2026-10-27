/**
 * Fallback: MyMemory (memória de tradução comunitária).
 *
 * Sem chave e com CORS liberado, mas com duas limitações que moldam o código:
 * traduz UM texto por request (não há batch) e tem cota diária por IP. Por isso
 * é fallback, não padrão — entra em cena quando o gtx falha.
 */

const ENDPOINT = 'https://api.mymemory.translated.net/get';

/** Limite do serviço, em caracteres: com 501 ele responde "QUERY LENGTH LIMIT EXCEEDED". */
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

/**
 * Pontos de corte, do mais natural ao último recurso. Todos têm largura zero:
 * os pedaços são fatias exatas do texto, e juntá-los devolve o original.
 */
const BREAKS = [
  /(?<=[.!?…]["'”’)\]]*\s)(?=\S)/u, // fim de frase
  /(?<=[;:,]\s)(?=\S)|(?<=[—–])(?=\S)/u, // pontuação interna e travessão
  /(?<=\s)(?=\S)/u, // entre palavras
];

/**
 * Quebra um texto em pedaços de até MAX_CHARS.
 *
 * Só fim de frase não basta: *Moby Dick* tem frases de mais de 2.000
 * caracteres, que iam inteiras e eram recusadas. Cada nível só é usado no
 * pedaço que o anterior não conseguiu encolher.
 */
export function splitLong(text, level = 0) {
  if (text.length <= MAX_CHARS) return [text];

  // "Palavra" maior que o limite (uma URL, por exemplo): corta onde der, sem
  // partir ao meio um caractere de dois códigos (emoji).
  if (level === BREAKS.length) {
    const pieces = [];
    let rest = text;
    while (rest.length > MAX_CHARS) {
      const cut = /[\uD800-\uDBFF]/.test(rest[MAX_CHARS - 1]) ? MAX_CHARS - 1 : MAX_CHARS;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    return rest ? [...pieces, rest] : pieces;
  }

  const pieces = [];
  let current = '';
  for (const unit of text.split(BREAKS[level])) {
    if (current && current.length + unit.length > MAX_CHARS) {
      pieces.push(current);
      current = '';
    }
    if (unit.length > MAX_CHARS) pieces.push(...splitLong(unit, level + 1));
    else current += unit;
  }
  if (current) pieces.push(current);
  return pieces;
}

export const myMemory = {
  id: 'mymemory',
  name: 'MyMemory',
  supportsDictionary: false,
  maxChunkChars: MAX_CHARS,

  async translateBatch(texts, targetLang, sourceLang = 'auto') {
    const out = [];
    for (const text of texts) {
      const translated = [];
      for (const piece of splitLong(text)) {
        const trimmed = piece.trim();
        if (trimmed) translated.push(await translateOne(trimmed, targetLang, sourceLang));
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
