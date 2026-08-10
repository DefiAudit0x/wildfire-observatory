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
