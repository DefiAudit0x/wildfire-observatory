export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 3,
  delayMs = 1500
): Promise<Response> {
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
      // to HTTP failures too.
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    } catch (e: any) {
      if (i === retries - 1) {
        throw e;
      }
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw new Error(`Failed after ${retries} retries`);
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
