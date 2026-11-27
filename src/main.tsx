/// <reference types="vite/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import { registerSW } from "virtual:pwa-register";
import App from "./App.tsx";
import { initMeshRelay } from "./lib/meshRelay.ts";
import "leaflet/dist/leaflet.css";
import "./index.css";

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN as string,
    environment: import.meta.env.PROD ? "production" : "development",
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 0,
  });
}

registerSW({ immediate: true });

// W-M12: stale-chunk safety net. A deploy can invalidate chunks an
// already-open tab is still requesting (React.lazy route splits); instead of
// a dead "Failed to fetch dynamically imported module" screen, reload ONCE —
// the sessionStorage guard prevents a reload loop if the failure persists.
// When storage itself is blocked the guard cannot persist, so there is no
// automatic reload at all — a manual retry banner is shown instead.
const CHUNK_LOAD_KEY = "chunk-load-reloaded";
let chunkRecoveryAttempted = false;
function isChunkLoadError(message: string): boolean {
  return (
    message.includes("Failed to fetch dynamically imported module") ||
    message.includes("Importing a module script failed") ||
    message.includes("error loading dynamically imported module") ||
    message.includes("Loading chunk")
  );
}
function recoverFromChunkLoadError(): void {
  if (chunkRecoveryAttempted) return;
  chunkRecoveryAttempted = true;
  try {
    if (sessionStorage.getItem(CHUNK_LOAD_KEY)) return;
    sessionStorage.setItem(CHUNK_LOAD_KEY, "1");
  } catch {
    // CodeRabbit (PR #215, Major): when storage is blocked the guard
    // above is exactly what fails — getItem/setItem throw, and the reload
    // below still happened. On the new document the module-level flag
    // resets, so a persistent chunk error reloaded in a loop with no
    // persistent guard. Do NOT reload automatically: offer a manual retry
    // instead, so the user stays in control of each attempt.
    showChunkLoadRetryBanner();
    return;
  }
  window.location.reload();
}

// Manual retry for a chunk-load failure when sessionStorage is unavailable
// (private mode / blocked storage): a fixed banner with a reload button.
// Plain DOM — the React tree may not have mounted when this fires.
function showChunkLoadRetryBanner(): void {
  if (document.getElementById("chunk-load-retry")) return;
  const banner = document.createElement("div");
  banner.id = "chunk-load-retry";
  banner.setAttribute("role", "alert");
  banner.style.cssText =
    "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;" +
    "background:#1c0505;color:#f8fafc;border:1px solid #7f1d1d;border-radius:12px;" +
    "padding:16px 20px;max-width:min(92vw,480px);text-align:center;" +
    "font-family:system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.5);";
  const text = document.createElement("p");
  text.style.cssText = "margin:0 0 12px;font-size:14px;line-height:1.5;";
  text.textContent =
    "تعذّر تحميل جزء من التطبيق — اضغط إعادة التحميل للمحاولة مجدداً. " +
    "Échec du chargement d'une partie de l'application — rechargez pour réessayer.";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "إعادة تحميل / Recharger";
  button.style.cssText =
    "padding:8px 16px;background:#dc2626;color:#fff;border:0;border-radius:8px;" +
    "font-size:14px;font-weight:700;cursor:pointer;";
  button.addEventListener("click", () => window.location.reload());
  banner.append(text, button);
  document.body.appendChild(banner);
}
window.addEventListener("error", (e) => {
  if (!e.message || !isChunkLoadError(e.message)) return;
  recoverFromChunkLoadError();
});
window.addEventListener("unhandledrejection", (e) => {
  const message = String((e.reason && (e.reason as Error).message) || e.reason || "");
  if (!isChunkLoadError(message)) return;
  recoverFromChunkLoadError();
});

// Store-and-forward mesh gateway: relay decryptable offline reports to the API
initMeshRelay();

const appErrorFallback = (
  <div className="min-h-screen bg-[#0a0505] text-slate-100 flex items-center justify-center p-8 text-center">
    <div>
      <h1 className="text-2xl font-bold text-red-500 mb-2">⚠️ خطأ في التطبيق</h1>
      <p className="text-slate-400 mb-1">يرجى إعادة تحميل الصفحة للمتابعة</p>
      <p className="text-xs text-gray-500 mb-4">Erreur de l'application — veuillez recharger la page</p>
      <button
        onClick={() => window.location.reload()}
        className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-bold transition-colors cursor-pointer"
      >
        إعادة تحميل / Recharger
      </button>
    </div>
  </div>
);

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={appErrorFallback}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
