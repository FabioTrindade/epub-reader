/**
 * Parser EPUB 2 e 3.
 *
 * Decisão central: o capítulo é a **entrada do sumário**, não o item do spine.
 * EPUBs reais (Project Gutenberg, por exemplo) fatiam o livro em arquivos
 * arbitrários — Pride and Prejudice tem 516 entradas de sumário em apenas 9
 * arquivos de spine. Tratar spine como capítulo entregaria 9 blocos gigantes.
 * Por isso cada capítulo guarda { docPath, fragment } e o conteúdo é recortado
 * do documento com Range (ver sliceBetween).
 */

import { notify } from './notifications.js';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/* --------------------------- utilidades de caminho -------------------------- */

/** Resolve href relativo tratando ../ e ./, e decodifica %20 etc. */
export function resolvePath(baseDir, href) {
  const clean = decodeURIComponent(href.split('#')[0].trim());
  if (!clean) return '';
  if (clean.startsWith('/')) return clean.slice(1);

  const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean);
  for (const seg of clean.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const fragmentOf = (href) => {
  const i = href.indexOf('#');
  return i === -1 ? '' : decodeURIComponent(href.slice(i + 1));
};

/* ------------------------------- identificação ------------------------------ */

/** SHA-256 do arquivo; identidade estável mesmo se o usuário renomear o EPUB. */
export async function hashBook(buffer, file) {
  if (window.isSecureContext && crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].slice(0, 16)
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  notify.warn(
    'insecure-context',
    'Identificação simplificada do livro',
    'crypto.subtle indisponível (contexto não seguro). Sirva o app por http://localhost para o hash completo.'
  );
  return `fb-${file.size}-${file.lastModified}-${file.name.length}`;
}

/* ---------------------------------- parsing --------------------------------- */

function parseXml(text, mime = 'application/xml') {
  const doc = new DOMParser().parseFromString(text, mime);
  if (doc.querySelector('parsererror')) {
    // XHTML malformado é comum; o parser de HTML é tolerante e resolve.
    return new DOMParser().parseFromString(text, 'text/html');
  }
  return doc;
}

/** Busca por tag ignorando namespace — OPF/NCX variam muito entre geradores. */
function byTag(root, name) {
  return [...root.getElementsByTagName('*')].filter(
    (el) => el.localName.toLowerCase() === name.toLowerCase()
  );
}

function firstByTag(root, name) {
  return byTag(root, name)[0] || null;
}

async function readText(zip, path) {
  const entry = zip.file(path);
  if (!entry) return null;
  return entry.async('text');
}

/* ------------------------------------ TOC ----------------------------------- */

/** EPUB 3: nav.xhtml com <nav epub:type="toc">. */
function parseNavDoc(text, navDir) {
  const doc = parseXml(text, 'application/xhtml+xml');
  const navs = byTag(doc, 'nav');
  const toc =
    navs.find((n) => (n.getAttribute('epub:type') || n.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type')) === 'toc') ||
    navs[0];
  if (!toc) return [];

  const entries = [];
  const walk = (ol, level) => {
    for (const li of [...ol.children].filter((c) => c.localName === 'li')) {
      const a = [...li.children].find((c) => c.localName === 'a' || c.localName === 'span');
      if (a) {
        const href = a.getAttribute('href');
        const title = a.textContent.trim().replace(/\s+/g, ' ');
        if (href && title) {
          entries.push({ title, docPath: resolvePath(navDir, href), fragment: fragmentOf(href), level });
        }
      }
      const child = [...li.children].find((c) => c.localName === 'ol');
      if (child) walk(child, level + 1);
    }
  };

  const rootOl = [...toc.children].find((c) => c.localName === 'ol');
  if (rootOl) walk(rootOl, 0);
  return entries;
}

/** EPUB 2: toc.ncx com navMap/navPoint aninhados. */
function parseNcx(text, ncxDir) {
  const doc = parseXml(text);
  const navMap = firstByTag(doc, 'navMap');
  if (!navMap) return [];

  const entries = [];
  const walk = (parent, level) => {
    for (const point of [...parent.children].filter((c) => c.localName === 'navPoint')) {
      const label = firstByTag(point, 'navLabel');
      const content = [...point.children].find((c) => c.localName === 'content');
      const title = label?.textContent.trim().replace(/\s+/g, ' ');
      const href = content?.getAttribute('src');
      if (title && href) {
        entries.push({ title, docPath: resolvePath(ncxDir, href), fragment: fragmentOf(href), level });
      }
      walk(point, level + 1);
    }
  };

  walk(navMap, 0);
  return entries;
}

/* --------------------------------- principal -------------------------------- */

export async function parseEpub(arrayBuffer, file) {
  const zip = await JSZip.loadAsync(arrayBuffer);

  // DRM: zip cifrado. Falhar aqui com mensagem clara é melhor que erro genérico
  // lá na frente, quando o capítulo vier ilegível.
  if (zip.file('META-INF/encryption.xml')) {
    notify.error('drm-detected', 'Livro protegido por DRM',
      'O conteúdo está cifrado e não pode ser aberto por um leitor no navegador.');
    throw new Error('DRM_PROTECTED');
  }

  const containerXml = await readText(zip, 'META-INF/container.xml');
  if (!containerXml) throw new Error('INVALID_EPUB: META-INF/container.xml ausente');

  const rootfile = firstByTag(parseXml(containerXml), 'rootfile');
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) throw new Error('INVALID_EPUB: rootfile sem full-path');

  const opfDir = dirOf(opfPath);
  const opfText = await readText(zip, opfPath);
  if (!opfText) throw new Error(`INVALID_EPUB: ${opfPath} não encontrado`);
  const opf = parseXml(opfText);

  /* --- metadados --- */
  const metaText = (name) => firstByTag(opf, name)?.textContent.trim() || '';
  const title = metaText('title') || file?.name?.replace(/\.epub$/i, '') || 'Sem título';
  const author = metaText('creator') || 'Autor desconhecido';
  const lang = (metaText('language') || 'en').slice(0, 2).toLowerCase();

  /* --- manifest: id → item --- */
  const manifest = new Map();
  const manifestEl = firstByTag(opf, 'manifest');
  for (const item of byTag(manifestEl || opf, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      path: resolvePath(opfDir, href),
      mediaType: item.getAttribute('media-type') || '',
      properties: item.getAttribute('properties') || '',
    });
  }

  /* --- spine: a ordem de leitura real --- */
  const spineEl = firstByTag(opf, 'spine');
  const spine = [];
  for (const ref of byTag(spineEl || opf, 'itemref')) {
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item) continue;
    if (ref.getAttribute('linear') === 'no') continue;
    if (!zip.file(item.path)) {
      notify.warn('chapter-missing', 'Capítulo não encontrado no EPUB', item.path);
      continue;
    }
    spine.push(item.path);
  }

  /* --- TOC: nav (EPUB 3) com fallback para ncx (EPUB 2) --- */
  let tocEntries = [];

  const navItem = [...manifest.values()].find((i) => i.properties.split(/\s+/).includes('nav'));
  if (navItem) {
    const text = await readText(zip, navItem.path);
    if (text) tocEntries = parseNavDoc(text, dirOf(navItem.path));
  }

  if (!tocEntries.length) {
    const ncxId = spineEl?.getAttribute('toc');
    const ncxItem = (ncxId && manifest.get(ncxId)) ||
      [...manifest.values()].find((i) => i.mediaType === 'application/x-dtbncx+xml');
    if (ncxItem) {
      const text = await readText(zip, ncxItem.path);
      if (text) tocEntries = parseNcx(text, dirOf(ncxItem.path));
    }
  }

  /* --- capítulos: entradas do TOC, reordenadas pela ordem do spine --- */
  const spineIndex = new Map(spine.map((p, i) => [p, i]));
  const byDoc = new Map();
  for (const entry of tocEntries) {
    if (!spineIndex.has(entry.docPath)) continue; // TOC pode apontar fora do spine
    if (!byDoc.has(entry.docPath)) byDoc.set(entry.docPath, []);
    byDoc.get(entry.docPath).push(entry);
  }

  const chapters = [];
  for (const docPath of spine) {
    const entries = byDoc.get(docPath);
    if (entries?.length) {
      chapters.push(...entries.map((entry) => ({ ...entry, inToc: true })));
    } else {
      // Documento sem entrada no sumário vira capítulo inteiro: nada fica inalcançável.
      chapters.push({ title: '', docPath, fragment: '', level: 0, inToc: false });
    }
  }

  assignTocPositions(chapters);

  if (!tocEntries.length) {
    notify.warn('toc-missing', 'Sumário ausente no arquivo',
      'Nenhum nav.xhtml ou toc.ncx encontrado; a lista de capítulos foi derivada da ordem de leitura.');
  }

  // Marca o fim de cada recorte: onde começa o próximo capítulo do mesmo arquivo.
  chapters.forEach((ch, i) => {
    ch.index = i;
    const next = chapters[i + 1];
    ch.endFragment = next && next.docPath === ch.docPath ? next.fragment : '';
    // Primeiro recorte de um arquivo começa do topo, para não perder o conteúdo
    // que vem antes da primeira âncora.
    ch.fromStart = i === 0 || chapters[i - 1].docPath !== ch.docPath;
  });

  /* --- capa --- */
  let cover = null;
  const coverId = byTag(opf, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
  const coverItem =
    [...manifest.values()].find((i) => i.properties.split(/\s+/).includes('cover-image')) ||
    (coverId && manifest.get(coverId));
  if (coverItem && zip.file(coverItem.path)) {
    cover = await zip.file(coverItem.path).async('blob');
  }

  const tocCount = chapters.filter((ch) => ch.inToc).length;
  return { title, author, lang, chapters, tocCount, cover, zip, opfDir };
}

/**
 * Liga cada documento fora do sumário à entrada que ele continua.
 *
 * O Calibre fatia capítulos longos em part0011_split_000, _001, _002… e o
 * sumário só aponta para o primeiro pedaço. Sem isto, cada pedaço vira um
 * "Capítulo 16" solto na lateral, quebrando a hierarquia Parte → Capítulo.
 * O pedaço continua sendo capítulo interno — setas, progresso e marcadores
 * salvos usam as mesmas posições —, só não ganha item próprio na lateral:
 * herda título e posição da entrada anterior. Antes da primeira entrada (a
 * capa que o gerador embrulha num xhtml), a herança vem da entrada seguinte.
 *
 * `tocPosition` é a posição do item da lateral que representa o capítulo.
 */
function assignTocPositions(chapters) {
  const entries = chapters.filter((ch) => ch.inToc);

  // Sem sumário que case com o spine, cada documento continua sendo um item.
  if (!entries.length) {
    chapters.forEach((ch, i) => {
      ch.inToc = true;
      ch.tocPosition = i;
    });
    return;
  }

  entries.forEach((ch, i) => { ch.tocPosition = i; });

  let owner = entries[0];
  for (const ch of chapters) {
    if (ch.inToc) {
      owner = ch;
      continue;
    }
    ch.title = owner.title;
    ch.level = owner.level;
    ch.tocPosition = owner.tocPosition;
  }
}

/* ------------------------------ leitura de capítulo ------------------------- */

const docCache = new Map(); // docPath → Document (por livro aberto)

export function clearDocCache() {
  docCache.clear();
}

async function loadDoc(zip, docPath) {
  if (docCache.has(docPath)) return docCache.get(docPath);

  const text = await readText(zip, docPath);
  if (text === null) {
    notify.warn('chapter-missing', 'Capítulo não encontrado no EPUB', docPath);
    return null;
  }

  const doc = parseXml(text, 'application/xhtml+xml');
  neutralizeImages(doc);
  // Cache pequeno: um arquivo do Gutenberg passa de 80KB e guardar todos pesa.
  if (docCache.size > 4) docCache.delete(docCache.keys().next().value);
  docCache.set(docPath, doc);
  return doc;
}

const XLINK_NS = 'http://www.w3.org/1999/xlink';

/**
 * Tira o `src` das imagens ANTES que o documento encoste no DOM principal.
 *
 * Sem isso, o clone do fragmento entra na página com o src original e o
 * navegador dispara um GET relativo à URL do app — que responde 404, porque o
 * arquivo mora dentro do zip. O caminho real vai para data-epub-src e o
 * renderer resolve depois, virando blob.
 */
function neutralizeImages(doc) {
  for (const el of doc.querySelectorAll('img, image')) {
    const src =
      el.getAttribute('src') ||
      el.getAttributeNS?.(XLINK_NS, 'href') ||
      el.getAttribute('xlink:href') ||
      el.getAttribute('href');

    if (!src) { el.remove(); continue; }

    // <image> só existe dentro de <svg>, que a sanitização descarta. Virar <img>
    // preserva capas que vêm embrulhadas em SVG — padrão comum em EPUB.
    const target = el.localName === 'image'
      ? el.ownerDocument.createElementNS(XHTML_NS, 'img')
      : el;

    target.setAttribute('data-epub-src', src);
    target.removeAttribute('src');
    target.removeAttribute('xlink:href');
    if (el.getAttribute('alt')) target.setAttribute('alt', el.getAttribute('alt'));

    if (target !== el) el.replaceWith(target);
  }
}

/** Acha a âncora: id no elemento ou o velho <a name="..."> do EPUB 2. */
function findAnchor(doc, fragment) {
  if (!fragment) return null;
  return (
    doc.getElementById?.(fragment) ||
    doc.querySelector(`[id="${CSS.escape(fragment)}"]`) ||
    doc.querySelector(`a[name="${CSS.escape(fragment)}"]`)
  );
}

/**
 * Recorta o trecho entre duas âncoras com Range.
 *
 * Range é o que faz isso funcionar com âncoras em profundidades diferentes:
 * cloneContents reconstrói os ancestrais parciais, devolvendo HTML válido.
 * Percorrer irmãos manualmente quebraria quando a âncora está aninhada.
 */
function rangeBetween(doc, startEl, endEl) {
  const body = doc.body || doc.documentElement;
  const range = doc.createRange();

  if (startEl) range.setStartBefore(startEl);
  else range.setStart(body, 0);

  if (endEl) range.setEndBefore(endEl);
  else range.setEnd(body, body.childNodes.length);

  return range;
}

function sliceBetween(doc, startEl, endEl) {
  return rangeBetween(doc, startEl, endEl).cloneContents();
}

/**
 * Conteúdo de um capítulo como DocumentFragment, pronto para o renderer.
 */
export async function getChapterContent(book, chapter) {
  const doc = await loadDoc(book.zip, chapter.docPath);
  if (!doc) return null;

  const startEl = chapter.fromStart ? null : findAnchor(doc, chapter.fragment);
  const endEl = findAnchor(doc, chapter.endFragment);
  return sliceBetween(doc, startEl, endEl);
}

/**
 * Mede o texto de cada capítulo, em caracteres.
 *
 * É a base do percentual de leitura: contar capítulos mentiria, porque eles
 * variam de 7 a ~45.000 caracteres nos livros testados. Roda uma vez por livro,
 * na importação.
 *
 * Usa Range.toString() em vez de cloneContents(): devolve o mesmo texto sem
 * copiar a subárvore, o que importa com 147 capítulos.
 *
 * @returns {Promise<number[]>} tamanho de cada capítulo, na ordem de leitura
 */
export async function measureChapters(book) {
  const lengths = new Array(book.chapters.length).fill(0);

  // Agrupar por arquivo: os 147 capítulos do Moby moram em 28 documentos, e
  // abrir cada um uma vez só é o que mantém a medição em dezenas de ms.
  const byDoc = new Map();
  for (const chapter of book.chapters) {
    if (!byDoc.has(chapter.docPath)) byDoc.set(chapter.docPath, []);
    byDoc.get(chapter.docPath).push(chapter);
  }

  for (const [docPath, chapters] of byDoc) {
    const doc = await loadDoc(book.zip, docPath);
    if (!doc) continue;

    for (const chapter of chapters) {
      const startEl = chapter.fromStart ? null : findAnchor(doc, chapter.fragment);
      const endEl = findAnchor(doc, chapter.endFragment);
      const text = rangeBetween(doc, startEl, endEl).toString();
      lengths[chapter.index] = text.replace(/\s+/g, ' ').trim().length;
    }
  }

  return lengths;
}

/**
 * Título do capítulo quando o sumário não deu um: primeiro cabeçalho do recorte.
 */
export function deriveTitle(fragment, index) {
  const heading = fragment?.querySelector?.('h1, h2, h3, h4, h5, h6');
  const text = heading?.textContent.trim().replace(/\s+/g, ' ');
  return text || `Capítulo ${index + 1}`;
}
