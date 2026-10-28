/**
 * Pedido HTTP com tempo-limite e cancelamento, comum aos provedores.
 *
 * Sem tempo-limite, um servidor que aceita a conexão e nunca responde deixava a
 * tradução parada em "Traduzindo N%" para sempre: o await não terminava, então
 * nem a nova tentativa nem a troca de serviço aconteciam.
 */

/** O Google responde em 1–2 s; 10 s cobre rede lenta sem deixar o leitor esperando. */
export const TIMEOUT_MS = 10_000;

/**
 * Faz o pedido e lê o corpo inteiro dentro do prazo: um corpo que para de
 * chegar no meio prende tanto quanto uma resposta que nunca começa.
 *
 * @param {string} url
 * @param {RequestInit} options
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} opts
 * @returns {Promise<{ res: Response, body: string }>}
 * @throws Error('ABORTED') quando `signal` cancela (o leitor trocou de capítulo
 *   ou clicou em "Cancelar tradução"); erro com code 'timeout' quando o prazo
 *   vence; o erro original do fetch nos demais casos.
 */
export async function fetchText(url, options = {}, { signal, timeoutMs = TIMEOUT_MS } = {}) {
  if (signal?.aborted) throw new Error('ABORTED');

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // AbortSignal.any juntaria os dois sinais, mas só existe em navegadores de 2024 em diante.
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const body = await res.text();
    return { res, body };
  } catch (err) {
    if (timedOut) {
      const timeout = new Error(`O serviço não respondeu em ${timeoutMs / 1000} segundos`);
      timeout.code = 'timeout';
      throw timeout;
    }
    if (signal?.aborted) throw new Error('ABORTED');
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
