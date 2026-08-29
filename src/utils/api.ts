export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 3,
  delayMs = 1500
): Promise<Response> {
  let lastError: any = null;
  for (let i = 0; i < retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const combinedSignal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;

      const res = await fetch(url, { ...options, signal: combinedSignal });
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        return res;
      }
      // Explicit retry policy: every non-4xx failure (5xx being the obvious
      // case) is retried AFTER the escalating delay — not immediately. The
      // catch below covers transport errors; this line makes the delay apply
      // to HTTP failures too. 4xx responses are returned immediately, by
      // contract: retrying a client error cannot change its verdict.
      if (i < retries - 1) {
        await sleep(delayMs * (i + 1), options.signal);
      }
    } catch (e: any) {
      // The caller aborted (options.signal): the retry schedule is cancelled
      // too, never a zombie timer waking up after the user gave up.
      if (options.signal?.aborted) throw e;
      if (i === retries - 1) {
        throw e;
      }
      lastError = e;
      await sleep(delayMs * (i + 1), options.signal);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  // ARC-L14 fix: the terminal failure used to throw a context-free "Failed
  // after N retries" that erased the real error (transport type, timeout vs
  // abort). Surface the last underlying error in the message.
  const detail = lastError?.message ? `: ${lastError.message}` : "";
  throw new Error(`Failed after ${retries} retries${detail}`);
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: number | undefined;
    const abort = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }
    timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
  });
}

export function cacheGet<T>(key: string, ttlMs = 300000): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { data, expiry } = JSON.parse(raw);
    if (Date.now() > expiry) { localStorage.removeItem(key); return null; }
    return data as T;
  } catch { return null; }
}

export function cacheSet<T>(key: string, data: T, ttlMs = 300000): void {
  localStorage.setItem(key, JSON.stringify({ data, expiry: Date.now() + ttlMs }));
}
