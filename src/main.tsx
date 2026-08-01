/// <reference types="vite/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App.tsx";
import "leaflet/dist/leaflet.css";
import "./index.css";

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN as string,
    environment: import.meta.env.PROD ? "production" : "development",
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 0,
  });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js");
  });
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<div className="min-h-screen bg-[#0a0505] text-slate-100 flex items-center justify-center p-8 text-center"><div><h1 className="text-2xl font-bold text-red-500 mb-2">⚠️ خطأ في التطبيق</h1><p className="text-slate-400">يرجى إعادة تحميل الصفحة</p></div></div>}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
