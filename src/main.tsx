import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

if (import.meta.env.PROD) {
  const h = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (typeof h === 'object' && h !== null) {
    Object.keys(h).forEach(k => { h[k] = typeof h[k] === 'function' ? () => {} : null; });
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
