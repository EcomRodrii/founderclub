import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './App.tsx';
import './index.css';

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN as string,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.1,
    environment: import.meta.env.PROD ? 'production' : 'development',
    beforeSend: (event) => {
      const val = event.exception?.values?.[0]?.value || '';
      if (val.includes('debugger') || val.includes('DevTools')) return null;
      return event;
    },
  });
}

// ── Bloquear React DevTools en producción ─────────────────────────────────────
if (import.meta.env.PROD) {
  const h = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (typeof h === 'object' && h !== null) {
    Object.keys(h).forEach(k => { h[k] = typeof h[k] === 'function' ? () => {} : null; });
  }
}

// ── Easter egg: trap para curiosos en DevTools ────────────────────────────────
// Accedemos a console via window para que terser (drop_console:true) no lo elimine
;(function _devtrap() {
  const _c = (window as any).console;

  // Capa 1 — Branding visible al abrir DevTools
  _c.clear();
  _c.log(
    '%c¡Para! %c👀',
    'color:#ff4444;font-size:40px;font-weight:900',
    'font-size:40px'
  );
  _c.log(
    '%cSi estás leyendo esto, casi crack.\nPero casi. 😄',
    'color:#a3e635;font-size:16px;font-weight:bold;background:#18181b;padding:12px 20px;border-radius:8px;border-left:4px solid #a3e635'
  );
  _c.log(
    '%c🔒 Los módulos premium están cifrados server-side.\n¿Sigues intentándolo? Únete a la academia: skool.com/lamineresell/plans',
    'color:#71717a;font-size:12px'
  );

  // Capa 2 — Detector por tamaño de ventana (DevTools lateral o inferior)
  const _threshold = 160;
  const _title = document.title;
  setInterval(() => {
    const open =
      window.outerWidth  - window.innerWidth  > _threshold ||
      window.outerHeight - window.innerHeight > _threshold;
    document.title = open ? '👀 Te veo...' : _title;
    if (open) {
      _c.warn(
        '%cCASI CRACK detected 🕵️',
        'color:orange;font-size:20px;font-weight:bold'
      );
    }
  }, 1000);

  // Capa 3 — Debugger trap en producción (ralentiza análisis si DevTools está pausando)
  // new Function bypasses terser drop_debugger; solo activa si el inspector está pausing
  if ((import.meta as any).env?.PROD) {
    const _dbg = new Function('debugger');
    setInterval(() => {
      const t = performance.now();
      _dbg();
      if (performance.now() - t > 100) {
        _c.log('%c¡Casi crack! 😂 Pero no.', 'color:lime;font-weight:bold;font-size:18px');
      }
    }, 3000);
  }
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
