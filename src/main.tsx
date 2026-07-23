import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Kill-switch: unregister any old broken service worker that caches HTML as JS
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((reg) => {
      // Unregister old sw that doesn't match our current one
      if (!reg.active || reg.active.scriptURL.includes("sw.js")) {
        const shouldUnregister = !reg.active ||
          reg.active.scriptURL !== window.location.origin + "/sw.js" ||
          reg.active.scriptURL.includes("localhost");
        if (shouldUnregister) {
          reg.unregister().then(() => {
            // Force reload to clear bad cache
            if (!window.location.hostname.includes("localhost")) {
              caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
            }
          });
        }
      }
    });
  });

  // Register our new service worker
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // SW registration failed - app works without it
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
