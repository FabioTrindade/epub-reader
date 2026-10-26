/**
 * Central de diagnóstico.
 *
 * Todo evento do app passa por aqui em vez de console.warn: falha de provider,
 * TOC ausente, cota estourada. O sino torna esses problemas visíveis sem DevTools.
 *
 * Duas regras de ouro:
 *  1. Eventos com o mesmo `code` são COALESCIDOS (×N) — 40 parágrafos falhando
 *     viram uma linha, não 40.
 *  2. Tudo vai para o sino; só warn/error também disparam toast.
 */

const MAX_ENTRIES = 50;

/** Catálogo: code → texto amigável. Manter em sincronia com o plano. */
export const CODES = {
  'drm-detected': 'Livro protegido por DRM',
  'toc-missing': 'Sumário ausente no arquivo',
  'chapter-missing': 'Capítulo não encontrado no EPUB',
  'asset-missing': 'Imagem ausente no EPUB',
  'content-sanitized': 'Conteúdo ativo removido',
  'translate-misaligned': 'Tradução re-alinhada parágrafo a parágrafo',
  'translate-ratelimited': 'Limite de requisições atingido',
  'provider-fallback': 'Trocando de serviço de tradução',
  'translate-failed': 'Falha ao traduzir',
  'offline': 'Sem conexão',
  'quota-exceeded': 'Espaço de armazenamento esgotado',
  'insecure-context': 'Recursos de segurança indisponíveis',
  'parse-failed': 'Não foi possível ler o EPUB',
  'storage-failed': 'Falha ao salvar dados',
};

const LEVEL_RANK = { info: 0, warn: 1, error: 2 };

class NotificationCenter extends EventTarget {
  #entries = [];
  #nextId = 1;

  /**
   * Emite um evento. Se `code` já existe, incrementa a contagem em vez de
   * criar outra entrada — é o que impede o painel de virar enxurrada.
   */
  #push(level, code, title, detail) {
    const existing = this.#entries.find((e) => e.code === code && e.level === level);

    let entry;
    if (existing) {
      existing.count += 1;
      existing.timestamp = Date.now();
      existing.read = false;
      // O detalhe mais recente costuma ser o mais útil para diagnosticar.
      if (detail) existing.detail = detail;
      entry = existing;
    } else {
      entry = {
        id: this.#nextId++,
        level,
        code,
        title: title || CODES[code] || code,
        detail: detail || '',
        timestamp: Date.now(),
        count: 1,
        read: false,
      };
      this.#entries.unshift(entry);
      if (this.#entries.length > MAX_ENTRIES) this.#entries.length = MAX_ENTRIES;
    }

    this.dispatchEvent(new CustomEvent('change', { detail: { entry, isNew: !existing } }));
    return entry;
  }

  info(code, title, detail) { return this.#push('info', code, title, detail); }
  warn(code, title, detail) { return this.#push('warn', code, title, detail); }
  error(code, title, detail) { return this.#push('error', code, title, detail); }

  /** Lista (mais recentes primeiro). Cópia rasa: a UI não deve mutar o estado. */
  list() { return this.#entries.slice(); }

  get unreadCount() { return this.#entries.filter((e) => !e.read).length; }

  /** Nível mais severo entre as não lidas — define a cor do badge. */
  get severity() {
    let worst = null;
    for (const e of this.#entries) {
      if (e.read) continue;
      if (!worst || LEVEL_RANK[e.level] > LEVEL_RANK[worst]) worst = e.level;
    }
    return worst;
  }

  markAllRead() {
    let changed = false;
    for (const e of this.#entries) {
      if (!e.read) { e.read = true; changed = true; }
    }
    if (changed) this.dispatchEvent(new CustomEvent('change', { detail: {} }));
  }

  clear() {
    this.#entries = [];
    this.dispatchEvent(new CustomEvent('change', { detail: {} }));
  }

  /** Dump em texto: transforma "não funcionou" em relato investigável. */
  toDiagnosticText() {
    const header = [
      `EPUB Reader — diagnóstico`,
      `Gerado em: ${new Date().toISOString()}`,
      `URL: ${location.href}`,
      `User agent: ${navigator.userAgent}`,
      `Online: ${navigator.onLine}`,
      `Contexto seguro: ${window.isSecureContext}`,
      `Idioma: ${navigator.language}`,
      '',
      `Eventos (${this.#entries.length}):`,
    ].join('\n');

    if (!this.#entries.length) return `${header}\n  (nenhum)`;

    const body = this.#entries
      .map((e) => {
        const when = new Date(e.timestamp).toISOString();
        const times = e.count > 1 ? ` ×${e.count}` : '';
        const detail = e.detail ? `\n      ${e.detail}` : '';
        return `  [${e.level.toUpperCase()}] ${e.code}${times} — ${e.title} (${when})${detail}`;
      })
      .join('\n');

    return `${header}\n${body}`;
  }
}

export const notify = new NotificationCenter();

// Erros não tratados também merecem ficar visíveis — senão somem no console.
window.addEventListener('error', (ev) => {
  notify.error('app-error', 'Erro inesperado', `${ev.message} (${ev.filename}:${ev.lineno})`);
});
window.addEventListener('unhandledrejection', (ev) => {
  notify.error('app-error', 'Erro inesperado', String(ev.reason?.message || ev.reason));
});
