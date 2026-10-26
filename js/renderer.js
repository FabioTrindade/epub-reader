/**
 * Renderização segura do conteúdo do capítulo.
 *
 * O XHTML vem de um arquivo de terceiros: tratamos como não-confiável.
 * Também descartamos o CSS do próprio livro de propósito — é a principal causa
 * de texto preto-sobre-preto no dark mode; a tipografia é do app.
 */

import { notify } from './notifications.js';
import { resolvePath } from './epub-parser.js';

const BLOCKED_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'link', 'style', 'meta', 'base', 'form', 'input', 'button',
]);

/** Tags que sobrevivem à limpeza. O resto é desembrulhado (filhos preservados). */
const ALLOWED_TAGS = new Set([
  'p', 'div', 'span', 'section', 'article', 'header', 'footer', 'main', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'em', 'i', 'strong', 'b', 'u', 's', 'small', 'sub', 'sup', 'mark', 'q', 'cite', 'abbr',
  'blockquote', 'pre', 'code', 'kbd', 'samp', 'var',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'img', 'figure', 'figcaption', 'picture', 'source',
  'br', 'hr', 'ruby', 'rt', 'rp', 'time', 'address', 'ins', 'del',
]);

const KEEP_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'id', 'colspan', 'rowspan', 'lang', 'dir', 'datetime',
  'data-epub-src', // caminho da imagem dentro do zip (ver neutralizeImages)
]);

export class ChapterRenderer {
  #objectUrls = [];

  /** Libera os blob URLs do capítulo anterior — sem isso vaza memória a cada navegação. */
  releaseAll() {
    for (const url of this.#objectUrls) URL.revokeObjectURL(url);
    this.#objectUrls = [];
  }

  /**
   * @param {DocumentFragment} fragment recorte vindo do parser
   * @param {object} book              livro aberto (para resolver recursos do zip)
   * @param {string} docPath           caminho do documento, base dos hrefs relativos
   * @param {(index:number, fragment:string)=>void} onInternalLink
   * @returns {HTMLElement} container pronto para inserir no DOM
   */
  render(fragment, book, docPath, onInternalLink) {
    const container = document.createElement('div');
    container.className = 'chapter-content';
    container.append(fragment.cloneNode(true));

    let sanitized = 0;
    sanitized += this.#stripBlocked(container);
    sanitized += this.#cleanAttributes(container);
    this.#unwrapUnknown(container);

    if (sanitized > 0) {
      notify.info('content-sanitized', 'Conteúdo ativo removido',
        `${sanitized} elemento(s)/atributo(s) de script removidos de ${docPath}`);
    }

    this.#wireLinks(container, book, docPath, onInternalLink);
    // Imagens carregam em segundo plano: o texto aparece imediatamente.
    this.#loadImages(container, book, docPath);

    return container;
  }

  #stripBlocked(root) {
    let count = 0;
    for (const el of [...root.querySelectorAll('*')]) {
      if (BLOCKED_TAGS.has(el.localName)) { el.remove(); count++; }
    }
    return count;
  }

  #cleanAttributes(root) {
    let count = 0;
    for (const el of [...root.querySelectorAll('*')]) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value;

        if (name.startsWith('on')) { el.removeAttribute(attr.name); count++; continue; }

        if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
          el.removeAttribute(attr.name); count++; continue;
        }

        if (!KEEP_ATTRS.has(name)) el.removeAttribute(attr.name);
      }
    }
    return count;
  }

  /** Tag desconhecida perde a tag mas mantém o texto — nada de conteúdo sumir. */
  #unwrapUnknown(root) {
    for (const el of [...root.querySelectorAll('*')]) {
      if (ALLOWED_TAGS.has(el.localName)) continue;
      el.replaceWith(...el.childNodes);
    }
  }

  #wireLinks(root, book, docPath, onInternalLink) {
    const baseDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';

    for (const a of root.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');

      if (/^(https?:|mailto:)/i.test(href)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.classList.add('external-link');
        continue;
      }

      // Link interno: mapeia para o capítulo correspondente.
      const targetPath = href.startsWith('#') ? docPath : resolvePath(baseDir, href);
      const frag = href.includes('#') ? decodeURIComponent(href.slice(href.indexOf('#') + 1)) : '';

      const chapter =
        book.chapters.find((c) => c.docPath === targetPath && c.fragment === frag) ||
        book.chapters.find((c) => c.docPath === targetPath);

      if (!chapter) { a.classList.add('dead-link'); continue; }

      a.classList.add('internal-link');
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        onInternalLink(chapter.index, frag);
      });
    }
  }

  async #loadImages(root, book, docPath) {
    const baseDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
    const images = [...root.querySelectorAll('img[data-epub-src]')];

    for (const img of images) {
      const src = img.getAttribute('data-epub-src');
      img.removeAttribute('data-epub-src');

      if (!src) { img.remove(); continue; }
      if (/^(https?:|data:|blob:)/i.test(src)) { img.setAttribute('src', src); continue; }

      const path = resolvePath(baseDir, src);
      const entry = book.zip.file(path);

      if (!entry) {
        notify.info('asset-missing', 'Imagem ausente no EPUB', path);
        img.remove();
        continue;
      }

      try {
        const blob = await entry.async('blob');
        const url = URL.createObjectURL(blob);
        this.#objectUrls.push(url);
        img.setAttribute('src', url);
        img.loading = 'lazy';
      } catch {
        img.remove();
      }
    }
  }
}

/**
 * Blocos traduzíveis, em ordem de leitura.
 *
 * Só folhas de texto: um <div> que contém <p> ficaria duplicado com os filhos.
 */
export function collectBlocks(container) {
  const selector = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt, figcaption, td, th';
  return [...container.querySelectorAll(selector)].filter((el) => {
    if (!el.textContent.trim()) return false;
    // Descarta contêineres: se tem bloco dentro, quem traduz é o filho.
    return !el.querySelector(selector);
  });
}
