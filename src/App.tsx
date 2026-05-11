import React, { useState, useEffect, useCallback } from 'react';
import {
  Eye, EyeOff, Search, Settings,
  Lock, User, ExternalLink, RefreshCcw,
  CheckCircle2, AlertCircle, ShieldCheck,
  ChevronRight, LayoutGrid, List as ListIcon,
  HelpCircle, Copy, Check, Scissors, Key, LogOut, TrendingUp
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import TongueEditor from './components/TongueEditor';
import AuthPage from './components/AuthPage';
import AdminPanel from './components/AdminPanel';
import ProfitControl from './components/ProfitControl';

// ─── Auth wrapper ─────────────────────────────────────────────────────────────

function LicenseActivation({ token, onActivated }: { token: string; onActivated: () => void }) {
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const activate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      let hwid = '';
      try {
        const FP = await import('@fingerprintjs/fingerprintjs');
        const fp = await FP.load();
        const result = await fp.get();
        hwid = result.visitorId;
      } catch {}

      const res = await fetch('/api/auth/activate-license', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ key: key.trim().toUpperCase(), hwid }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setSuccess(true);
      setTimeout(onActivated, 1200);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-amber-500/20 border border-amber-500/30 mb-4">
            <Key className="w-8 h-8 text-amber-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">Activar licencia</h1>
          <p className="text-zinc-500 text-sm mt-1">Introduce tu clave para acceder</p>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
          {success ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <CheckCircle2 className="w-12 h-12 text-emerald-400" />
              <p className="text-white font-medium">¡Licencia activada!</p>
            </div>
          ) : (
            <form onSubmit={activate} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Clave de licencia</label>
                <input
                  type="text"
                  value={key}
                  onChange={e => setKey(e.target.value.toUpperCase())}
                  placeholder="FC-XXXX-XXXX-XXXX-XXXX"
                  required
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm font-mono text-white placeholder-zinc-500 focus:outline-none focus:border-amber-500 transition"
                />
              </div>
              {error && (
                <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5 text-sm text-red-400">
                  <AlertCircle className="w-4 h-4 shrink-0" />{error}
                </div>
              )}
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-semibold rounded-xl py-2.5 text-sm transition"
              >
                {loading ? 'Activando…' : 'Activar'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem('fc_token'));
  const [authUser, setAuthUser] = useState<any>(null);
  const [license, setLicense] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [showAdmin, setShowAdmin] = useState(false);

  useEffect(() => {
    if (!authToken) { setAuthLoading(false); return; }
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => r.json())
      .then(data => {
        if (data.user) { setAuthUser(data.user); setLicense(data.license); }
        else { localStorage.removeItem('fc_token'); setAuthToken(null); }
      })
      .catch(() => { localStorage.removeItem('fc_token'); setAuthToken(null); })
      .finally(() => setAuthLoading(false));
  }, [authToken]);

  const handleAuth = (token: string, user: any) => {
    setAuthToken(token);
    setAuthUser(user);
    setAuthLoading(true);
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { setLicense(data.license); })
      .finally(() => setAuthLoading(false));
  };

  const handleLogout = () => {
    localStorage.removeItem('fc_token');
    setAuthToken(null);
    setAuthUser(null);
    setLicense(null);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!authToken || !authUser) return <AuthPage onAuth={handleAuth} />;
  if (!license && !authUser.is_admin) return <LicenseActivation token={authToken} onActivated={() => {
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => r.json()).then(data => setLicense(data.license));
  }} />;

  if (authUser.is_admin && showAdmin) return (
    <AdminPanel token={authToken} onLogout={handleLogout} onBack={() => setShowAdmin(false)} />
  );

  return <MainApp token={authToken} user={authUser} license={license} onLogout={handleLogout} onAdmin={authUser.is_admin ? () => setShowAdmin(true) : undefined} />;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface VintedItem {
  id: number;
  title: string;
  photo?: { url: string };
  is_hidden?: boolean;
  price?: { amount: string; currency_code: string };
  url: string;
}

const DOMAINS = ['es', 'fr', 'it', 'nl', 'de', 'pl', 'uk', 'com'];

// ─── Main App ─────────────────────────────────────────────────────────────────

function MainApp({ token, user, license, onLogout, onAdmin }: { token: string; user: any; license: any; onLogout: () => void; onAdmin?: () => void }) {
  const authHeader = { Authorization: `Bearer ${token}` };

  // Helper to add auth to fetch calls
  const apiFetch = (url: string, options: RequestInit = {}) =>
    fetch(url, { ...options, headers: { ...options.headers as any, ...authHeader } });
  const [cookie, setCookie] = useState<string>(() => localStorage.getItem('vinted_cookie') || 'eyJraWQiOiJFNTdZZHJ1SHBsQWp1MmNObzFEb3JIM2oyN0J1NS1zX09QNVB3UGlobjVNIiwiYWxnIjoiUFMyNTYifQ.eyJhY2NvdW50X2lkIjozMTU3MTYwMTc4LCJhcHBfaWQiOjQsImF1ZCI6ImZyLmNvcmUuYXBpIiwiY2xpZW50X2lkIjoid2ViIiwiZXhwIjoxNzc4MTczOTQyLCJpYXQiOjE3NzgxNjY3NDIsImlzcyI6InZpbnRlZC1pYW0tc2VydmljZSIsInB1cnBvc2UiOiJhY2Nlc3MiLCJyb2xlcyI6IiIsInNjb3BlIjoidXNlciIsInNpZCI6IjRmNDBkNWNlLTE3NzgxMDkyMDkiLCJzdWIiOiIzMTUyNzYzOTA4IiwiY2MiOiJFUyIsImFuaWQiOiJiM2MzZTg0Mi00M2UyLTQ4MTUtODE1Zi00OTI2MjU0MTg5NGMiLCJhY3QiOnsic3ViIjoiMzE1Mjc2MzkwOCJ9fQ.I-IhZ_6EEaQhahcLO91o0CrsSQUt9FKFrlJc6hs7C4-7prK0txXbc-q495VsLX11kjVOaBkJg1GfErbF60vLJl5F1wKfU6ga-icHJhJh2DKEhkXH_aYso_Ofm5a3yDx4x_xVyxRpwmkkLmlfGG3SyhtYg-_PFUTzXH4Y8aFt8qEhie7Wk792FvQXHMS8RexAhAOn9o9A2nGiHCVpSjDk2tKXsprQbp8um6OuWkatx4YrxcT2KayI_utEviw3_s9dP09HKeE3MMMsDPqb5EAPPzEn_H1YoZkCquIaowvTBfEkVa3mo-qCYa6CErxkjUYkC-1f_PDCVK3h8TpMF4mmUg');
  const [userId, setUserId] = useState<string>(() => localStorage.getItem('vinted_user_id') || '3152763908');
  const [domain, setDomain] = useState<string>(() => localStorage.getItem('vinted_domain') || 'es');
  const [profileUrl, setProfileUrl] = useState('https://www.vinted.es/member/3152763908');
  const [activeTab, setActiveTab] = useState<'mine' | 'external' | 'tongues' | 'profits'>('mine');
  
  // External Report State
  const [externalUrl, setExternalUrl] = useState('');
  const [externalId, setExternalId] = useState('');
  const [externalTitle, setExternalTitle] = useState('');
  const [reportReason, setReportReason] = useState('1');
  
  const [items, setItems] = useState<VintedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [showCookieHelp, setShowCookieHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sessionValid, setSessionValid] = useState<boolean | null>(null);
  const [cookieWarning, setCookieWarning] = useState<string | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Persistence
  useEffect(() => {
    localStorage.setItem('vinted_cookie', cookie);
    localStorage.setItem('vinted_user_id', userId);
    localStorage.setItem('vinted_domain', domain);

    const hasVintedSession = cookie.toLowerCase().includes('_vinted_');
    const hasToken = cookie.toLowerCase().includes('token') || cookie.trim().startsWith('eyJ');

    if (cookie && !hasVintedSession && !hasToken) {
      setCookieWarning('⚠️ Formato desconocido: Asegúrate de copiar la cookie completa o un token JWT válido.');
    } else {
      setCookieWarning(null);
      // Auto-detect domain if not explicitly set
      if (cookie?.includes('_vinted_fr_') || cookie?.includes('vinted.fr')) setDomain('fr');
      else if (cookie?.includes('_vinted_it_') || cookie?.includes('vinted.it')) setDomain('it');
      else if (cookie?.includes('_vinted_es_') || cookie?.includes('vinted.es')) setDomain('es');
    }
  }, [cookie, userId]);

  const validateSession = async () => {
    if (!cookie) return;
    try {
      const res = await apiFetch('/api/vinted/check-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie, domain })
      });
      const data = await res.json();
      setSessionValid(data.valid);
      if (data.valid && data.user?.id) {
        setUserId(data.user.id.toString());
        setStatus(`Sesión activa como ${data.user.username}`);
      } else {
        setStatus(`Sesión inválida (Error ${data.status || 'unknown'})`);
        if (data.status === 401) {
          setError('⚠️ Vinted ha rechazado tu token (401). Esto suele ocurrir si el token ha expirado o si faltan las cookies de sesión (_vinted_s). Intenta copiar la cookie completa desde Network.');
        }
      }
    } catch (e) {
      setSessionValid(false);
    }
  };

  useEffect(() => {
    if (cookie) validateSession();
  }, [cookie]);

  const resolveUserId = async () => {
    if (!profileUrl) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/vinted/resolve-user?url=${encodeURIComponent(profileUrl)}`);
      const data = await res.json();
      if (data.userId) {
        setUserId(data.userId);
        setStatus('ID de usuario resuelto con éxito');
      } else {
        setError('No se pudo encontrar el ID de usuario en esta URL.');
      }
    } catch (err) {
      setError('Error al conectar con el servidor.');
    } finally {
      setLoading(false);
    }
  };

  const resolveProductId = async () => {
    if (!externalUrl) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/vinted/resolve-product?url=${encodeURIComponent(externalUrl)}`);
      const data = await res.json();
      if (data.itemId) {
        setExternalId(data.itemId);
        setExternalTitle(data.title || 'Producto detectado');
        setStatus('ID de producto detectado: ' + data.itemId);
      } else {
        setError('No se pudo detectar el ID del producto.');
      }
    } catch (err) {
      setError('Error al contactar con el proxy.');
    } finally {
      setLoading(false);
    }
  };

  const fetchItems = useCallback(async () => {
    if (!cookie || !userId) {
      setError('Se requiere Cookie y ID de Usuario');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/vinted/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie, userId, domain, userUrl: profileUrl })
      });
      const data = await res.json();
      if (data.items) {
        setItems(data.items);
        setStatus(`${data.items.length} productos cargados.`);
      } else {
        const rawDetail = data.details;
        let detailMessage = '';
        
        if (typeof rawDetail === 'string') {
          if (rawDetail.includes('<html')) {
            detailMessage = 'Vinted devolvió una página de error HTML (404/Block). Verifica que el ID de usuario sea correcto para el dominio seleccionado.';
          } else {
            detailMessage = rawDetail;
          }
        } else {
          detailMessage = JSON.stringify(rawDetail);
        }
        
        setError(`${data.error || 'Error'}: ${detailMessage}`);
        if (data.status === 401) {
          setSessionValid(false);
        }
      }
    } catch (err: any) {
      const errorDetail = err.response?.data?.details || err.response?.data?.error || err.message;
      setError(`Error de conexión: ${errorDetail || 'El servidor no responde'}`);
      console.error('Inventory Error:', err.response?.data);
    } finally {
      setLoading(false);
    }
  }, [cookie, userId, domain]);

  const toggleVisibility = async (itemId: number, currentlyHidden: boolean) => {
    setStatus(`Procesando item ${itemId}...`);
    try {
      const endpoint = !currentlyHidden ? '/api/vinted/hide' : '/api/vinted/reveal';
      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie, itemId, domain })
      });
      const data = await res.json();
      if (data.success) {
        setItems(prev => prev.map(item => 
          item.id === itemId ? { ...item, is_hidden: !currentlyHidden } : item
        ));
        setStatus(`Item ${itemId} ${!currentlyHidden ? 'oculto' : 'visible'} con éxito.`);
      } else {
        setError(`Error al cambiar visibilidad: ${data.details?.message || data.error}`);
      }
    } catch (err) {
      setError('Error de comunicación con el servidor.');
    }
  };

  const [itemStats, setItemStats] = useState<{ visible: boolean; checked: boolean }>({ visible: true, checked: false });
  const [stealthDescription, setStealthDescription] = useState('This item is a replica and uses stock photos from a luxury brand website. Selling counterfeits is against Vinted safety policies.');

  const checkPublicStatus = async () => {
    if (!externalId) return;
    try {
      const res = await fetch(`/api/vinted/item-status?itemId=${externalId}&domain=${domain}`);
      const data = await res.json();
      setItemStats({ visible: data.visible, checked: true });
      if (!data.visible) {
        setStatus('¡ÉXITO! El producto ya no es visible públicamente.');
      }
    } catch (err) {}
  };

  const reportItem = async () => {
    let targetId = externalId;
    
    if (!cookie) {
      setError('⚠️ CONFIGURACIÓN REQUERIDA: Introduce tu Cookie en el panel lateral izquierdo.');
      return;
    }

    if (!targetId && externalUrl) {
      setStatus('Detectando ID automáticamente...');
      try {
        const res = await fetch(`/api/vinted/resolve-product?url=${encodeURIComponent(externalUrl)}`);
        const data = await res.json();
        if (data.itemId) {
          targetId = data.itemId;
          setExternalId(data.itemId);
          setExternalTitle(data.title || 'Producto detectado');
        } else {
          setError('No se pudo extraer el ID de la URL automáticamente.');
          return;
        }
      } catch (e) {
        setError('Error al intentar resolver la URL.');
        return;
      }
    }

    if (!targetId) {
      setError('⚠️ URL REQUERIDA: Pega la URL del producto que deseas ocultar.');
      return;
    }

    setLoading(true);
    setStatus('Iniciando maniobra de ocultación...');
    try {
      const res = await apiFetch('/api/vinted/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cookie,
          itemId: targetId,
          reasonId: parseInt(reportReason),
          description: stealthDescription,
          domain
        })
      });
      const data = await res.json();
      if (data.success) {
        setStatus('Payload enviado con éxito. Vinted está procesando la solicitud de revisión.');
        // Start polling status
        setTimeout(checkPublicStatus, 3000);
      } else {
        setError('Error en la comunicación: ' + (data.details?.message || data.error));
      }
    } catch (err) {
      setError('Error de red al intentar reportar.');
    } finally {
      setLoading(false);
    }
  };

  const spamCheckout = async () => {
    let targetId = externalId;
    if (!cookie) {
      setError('⚠️ CONFIGURACIÓN REQUERIDA: Introduce tu Cookie.');
      return;
    }

    if (!targetId && externalUrl) {
      try {
        const res = await fetch(`/api/vinted/resolve-product?url=${encodeURIComponent(externalUrl)}`);
        const data = await res.json();
        if (data.itemId) targetId = data.itemId;
      } catch (e) {}
    }

    if (!targetId) {
      setError('⚠️ URL REQUERIDA.');
      return;
    }

    setLoading(true);
    setStatus('Iniciando bombardeo táctico...');
    const startTime = Date.now();
    try {
      const res = await apiFetch('/api/vinted/spam-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie, itemId: targetId, domain })
      });
      const data = await res.json();
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      
      if (data.success) {
        setStatus(`¡ATAQUE COMPLETADO en ${duration}s! ${data.count} impactos registrados.`);
        // Start monitoring
        let checkCount = 0;
        const interval = setInterval(async () => {
          checkCount++;
          await checkPublicStatus();
          if (checkCount > 12) clearInterval(interval);
        }, 5000);
      } else {
        setError(`Ataque rechazado por el cortafuegos de Vinted. Código: ${data.status || '403/429'}`);
      }
    } catch (err) {
      setError('Fallo crítico en el túnel de ataque.');
    } finally {
      setLoading(false);
    }
  };

  const STEALTH_TEMPLATES = [
    { label: 'Falsificación (AI Trigger)', text: 'This item is a non-authentic replica violating IP rights. It uses stock imagery and serial numbers known to be associated with mass-produced counterfeit batches. Violation of Vinted Integrity Policy.' },
    { label: 'Prohibido (High Priority)', text: 'Article belongs to the prohibited items list (electronics/safety/hygiene violation). Poses a transaction risk for buyers. Requires immediate automated quarantine.' },
    { label: 'Imágenes Robadas', text: 'Listing uses copyrighted photographs without authorization from the legal representative. Commercial rights violation.' }
  ];

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e0e0e0] font-sans selection:bg-emerald-500/30 selection:text-emerald-400">
      {/* Top Banner / Navigation */}
      <nav className="border-b border-white/10 px-4 lg:px-6 py-3 lg:py-4 flex items-center justify-between bg-black/50 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-2 lg:gap-3">
          <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(16,185,129,0.3)]">
            <ShieldCheck className="w-5 h-5 text-black" />
          </div>
          <div>
            <h1 className="text-base lg:text-xl font-bold tracking-tighter bg-gradient-to-r from-white to-white/70 bg-clip-text text-transparent">
              FounderClub
            </h1>
            <p className="hidden lg:block text-[10px] text-white/40 uppercase tracking-[0.2em] font-mono leading-none">Automated Privacy Controller</p>
          </div>
        </div>

        <div className="flex items-center gap-2 lg:gap-4">
          {/* Session indicator */}
          <div className={`w-2 h-2 rounded-full ${sessionValid === true ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : sessionValid === false ? 'bg-red-500' : 'bg-white/20'}`} />
          <span className={`hidden sm:inline text-xs font-mono ${sessionValid === true ? 'text-emerald-400' : sessionValid === false ? 'text-red-400' : 'text-white/40'}`}>
            {sessionValid === true ? 'Active' : sessionValid === false ? 'Expired' : '...'}
          </span>
          <div className="hidden lg:block h-6 w-[1px] bg-white/10" />
          <button
            onClick={() => setShowCookieHelp(!showCookieHelp)}
            className="hidden lg:flex p-2 hover:bg-white/5 rounded-full transition-colors text-white/60 hover:text-white"
          >
            <HelpCircle className="w-5 h-5" />
          </button>
          <div className="hidden lg:block h-6 w-[1px] bg-white/10" />
          <span className="hidden lg:inline text-xs text-white/50 font-mono">{user.username}</span>
          {onAdmin && (
            <button
              onClick={onAdmin}
              title="Panel de Admin"
              className="hidden lg:flex p-2 hover:bg-violet-500/10 rounded-lg transition-colors text-violet-400/60 hover:text-violet-400"
            >
              <ShieldCheck className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onLogout}
            title="Cerrar sesión"
            className="p-2 hover:bg-white/5 rounded-lg transition-colors text-white/40 hover:text-red-400"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </nav>

      {/* Mobile sidebar drawer overlay */}
      <AnimatePresence>
        {mobileSidebarOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileSidebarOpen(false)}
              className="fixed inset-0 bg-black/60 z-40 lg:hidden"
            />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="fixed bottom-16 left-0 right-0 z-50 bg-[#141414] border-t border-white/10 rounded-t-3xl p-5 max-h-[80vh] overflow-y-auto lg:hidden"
            >
              <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />
              <div className="space-y-4">
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-white/30 mb-1.5 ml-1">Dominio Vinted</label>
                  <select value={domain} onChange={e => setDomain(e.target.value)}
                    className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-3 text-sm focus:outline-none focus:border-emerald-500/50 appearance-none">
                    {DOMAINS.map(d => <option key={d} value={d}>vinted.{d}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-white/30 mb-1.5 ml-1">URL de perfil</label>
                  <div className="flex gap-2">
                    <input type="text" placeholder="https://www.vinted.es/member/..."
                      value={profileUrl} onChange={e => setProfileUrl(e.target.value)}
                      className="flex-1 bg-black/30 border border-white/10 rounded-lg px-3 py-3 text-sm focus:outline-none focus:border-emerald-500/50" />
                    <button onClick={() => { resolveUserId(); setMobileSidebarOpen(false); }}
                      className="p-3 bg-emerald-500/10 text-emerald-400 rounded-lg border border-emerald-500/20">
                      <Search className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-white/30 mb-1.5 ml-1">Cookie de sesión</label>
                  <textarea value={cookie} onChange={e => setCookie(e.target.value)}
                    placeholder="_vinted_fr_session=..."
                    className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-3 text-sm font-mono h-24 resize-none focus:outline-none focus:border-emerald-500/50" />
                </div>
                <button onClick={() => { fetchItems(); setMobileSidebarOpen(false); }} disabled={loading}
                  className="w-full bg-emerald-500 text-black font-bold py-3.5 rounded-xl hover:bg-emerald-400 transition-all flex items-center justify-center gap-2 disabled:opacity-50 text-base">
                  {loading ? <RefreshCcw className="w-5 h-5 animate-spin" /> : <LayoutGrid className="w-5 h-5" />}
                  Cargar inventario
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Mobile bottom navigation */}
      <div className="fixed bottom-0 left-0 right-0 z-40 lg:hidden bg-black/90 backdrop-blur-xl border-t border-white/10">
        <div className="flex items-center justify-around px-2 py-2 pb-safe">
          {[
            { id: 'config', icon: <Settings className="w-5 h-5" />, label: 'Config', action: () => setMobileSidebarOpen(o => !o) },
            { id: 'mine', icon: <LayoutGrid className="w-5 h-5" />, label: 'Mis artículos', action: () => { setActiveTab('mine'); setMobileSidebarOpen(false); } },
            { id: 'external', icon: <ShieldCheck className="w-5 h-5" />, label: 'Ocultar', action: () => { setActiveTab('external'); setMobileSidebarOpen(false); } },
            { id: 'tongues', icon: <Scissors className="w-5 h-5" />, label: 'Lengüeta', action: () => { setActiveTab('tongues'); setMobileSidebarOpen(false); } },
            { id: 'profits', icon: <TrendingUp className="w-5 h-5" />, label: 'Beneficios', action: () => { setActiveTab('profits'); setMobileSidebarOpen(false); } },
          ].map(item => {
            const isActive = item.id === 'config' ? mobileSidebarOpen : (item.id !== 'config' && activeTab === item.id);
            return (
              <button key={item.id} onClick={item.action}
                className={`flex flex-col items-center gap-1 px-4 py-1.5 rounded-xl transition-all ${isActive ? 'text-emerald-400' : 'text-white/30'}`}>
                {item.icon}
                <span className="text-[9px] font-medium uppercase tracking-wider">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <main className="max-w-7xl mx-auto p-4 lg:p-6 pb-24 lg:pb-6 grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-8">
        {/* Sidebar Configuration — desktop only */}
        <div className="hidden lg:block space-y-6">
          <section className="bg-[#141414] border border-white/5 rounded-2xl p-6 shadow-xl relative overflow-hidden group">
            <div className="absolute top-0 left-0 w-1 h-full bg-emerald-500 opacity-50 group-hover:opacity-100 transition-opacity" />
            
            <div className="flex items-center gap-2 mb-6">
              <Settings className="w-4 h-4 text-emerald-400" />
              <h2 className="text-xs uppercase tracking-widest font-bold text-white/50">Configuración de Acceso</h2>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-white/30 mb-1.5 ml-1">Dominio Vinted</label>
                <select 
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500/50 transition-colors appearance-none cursor-pointer hover:bg-black/50"
                >
                  {DOMAINS.map(d => (
                    <option key={d} value={d}>vinted.{d}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] uppercase tracking-wider text-white/30 mb-1.5 ml-1">Profile URL / User ID</label>
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    placeholder="Enlace al perfil de Vinted"
                    value={profileUrl}
                    onChange={(e) => setProfileUrl(e.target.value)}
                    className="flex-1 bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500/50 transition-colors"
                  />
                  <button 
                    onClick={resolveUserId}
                    className="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg hover:bg-emerald-500/20 transition-colors border border-emerald-500/20"
                  >
                    <Search className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="relative">
                <label className="block text-[10px] uppercase tracking-wider text-white/30 mb-1.5 ml-1">Vinted Session Cookie</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
                  <textarea 
                    value={cookie}
                    onChange={(e) => setCookie(e.target.value)}
                    placeholder="_vinted_fr_session=..."
                    className={`w-full bg-black/30 border ${cookieWarning ? 'border-red-500/50' : 'border-white/10'} rounded-lg pl-10 pr-3 py-3 text-sm focus:outline-none focus:border-emerald-500/50 transition-colors h-24 font-mono resize-none`}
                  />
                </div>
                {cookieWarning && (
                  <motion.p 
                    initial={{ opacity: 0, y: -5 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-2 text-[10px] text-red-400 leading-tight bg-red-400/5 p-2 rounded-lg border border-red-400/10"
                  >
                    {cookieWarning}
                  </motion.p>
                )}
              </div>

              <div className="pt-4">
                <button 
                  onClick={fetchItems}
                  disabled={loading}
                  className="w-full bg-emerald-500 text-black font-bold py-3 rounded-xl hover:bg-emerald-400 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_20px_rgba(16,185,129,0.2)]"
                >
                  {loading ? <RefreshCcw className="w-5 h-5 animate-spin" /> : <LayoutGrid className="w-5 h-5" />}
                  Cargar Inventario
                </button>
              </div>
            </div>
          </section>

          {showCookieHelp && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-6 text-sm leading-relaxed"
            >
              <h3 className="text-emerald-400 font-bold mb-4 flex items-center gap-2">
                <HelpCircle className="w-4 h-4" /> ¿Cómo obtener la Cookie de Sesión?
              </h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <p className="text-xs font-bold text-white/80">Opción A: Método Rápido</p>
                  <ol className="list-decimal list-inside space-y-2 text-[11px] text-white/50">
                    <li>Entra en <span className="text-white">vinted.es</span> y logueate.</li>
                    <li>Presiona <kbd className="bg-white/10 px-1 rounded border border-white/20">F12</kbd> y ve a la pestaña <span className="text-white">Consola</span>.</li>
                    <li>Escribe <code className="text-emerald-400">copy(document.cookie)</code> y dale al Enter.</li>
                    <li>
                      <button 
                        onClick={() => copyToClipboard('copy(document.cookie)')}
                        className="mt-2 flex items-center gap-2 px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 rounded-lg text-[10px] text-emerald-400 transition-all"
                      >
                        <Copy className="w-3 h-3" /> Copiar comando para Consola
                      </button>
                    </li>
                  </ol>
                </div>

                <div className="space-y-3">
                  <p className="text-xs font-bold text-white/80">Opción B: Método Infalible (Network)</p>
                  <ol className="list-decimal list-inside space-y-2 text-[11px] text-white/50">
                    <li>En el panel F12, ve a la pestaña <span className="text-white">Red (Network)</span>.</li>
                    <li>Recarga la página de Vinted.</li>
                    <li>Busca la primera petición llamada <span className="text-white">vinted.es</span>.</li>
                    <li>En la sección <span className="text-white">Request Headers</span>, copia el valor de <span className="text-emerald-400">Cookie</span>.</li>
                  </ol>
                </div>
              </div>

              <div className="mt-6 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-[10px] text-red-300/80">
                <strong>⚠️ ERROR 401:</strong> Si ves este error, significa que tu sesión ha caducado o la cookie no incluye el id de sesión. Repite el proceso asegurándote de estar logueado en la misma pestaña.
              </div>
            </motion.div>
          )}

          {error && (
            <motion.div 
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              className="bg-red-500/10 border border-red-500/20 rounded-2xl p-4 flex gap-3 text-red-200"
            >
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <p className="text-xs leading-5">{error}</p>
            </motion.div>
          )}
        </div>

        {/* Content Area */}
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 px-2 gap-4">
            <div>
              <h2 className="hidden lg:block text-xl font-bold tracking-tight">Panel de Control</h2>
              <div className="hidden lg:flex gap-4 mt-2">
                <button
                  onClick={() => setActiveTab('mine')}
                  className={`text-xs uppercase tracking-widest font-bold pb-1 border-b-2 transition-all ${activeTab === 'mine' ? 'border-emerald-500 text-white' : 'border-transparent text-white/30 hover:text-white/60'}`}
                >
                  Mis Productos
                </button>
                <button
                  onClick={() => setActiveTab('external')}
                  className={`text-xs uppercase tracking-widest font-bold pb-1 border-b-2 transition-all ${activeTab === 'external' ? 'border-emerald-500 text-white' : 'border-transparent text-white/30 hover:text-white/60'}`}
                >
                  Ocultar Externo
                </button>
                <button
                  onClick={() => setActiveTab('tongues')}
                  className={`text-xs uppercase tracking-widest font-bold pb-1 border-b-2 transition-all ${activeTab === 'tongues' ? 'border-emerald-500 text-white' : 'border-transparent text-white/30 hover:text-white/60'}`}
                >
                  Cambiar Lengüeta
                </button>
                <button
                  onClick={() => setActiveTab('profits')}
                  className={`text-xs uppercase tracking-widest font-bold pb-1 border-b-2 transition-all ${activeTab === 'profits' ? 'border-emerald-500 text-white' : 'border-transparent text-white/30 hover:text-white/60'}`}
                >
                  Beneficios
                </button>
              </div>
            </div>
            
            {activeTab === 'mine' && (
              <div className="flex bg-white/5 rounded-lg p-1 border border-white/10 self-start sm:self-auto">
                <button className="p-2 bg-emerald-500/20 text-emerald-400 rounded-md">
                  <LayoutGrid className="w-4 h-4" />
                </button>
                <button className="p-2 text-white/30 hover:text-white transition-colors">
                  <ListIcon className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {activeTab === 'mine' && (
            <>
              {!items.length && !loading && (
                <div className="h-[500px] border border-dashed border-white/10 rounded-3xl flex flex-col items-center justify-center text-center px-10">
                  <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center mb-6 border border-white/5">
                    <Search className="w-10 h-10 text-white/10" />
                  </div>
                  <h3 className="text-lg font-medium text-white/60 mb-2">Artículos Propios</h3>
                  <p className="text-sm text-white/30 max-w-xs">Introduce tu cookie y ID de usuario para cargar tu inventario y ocultar/mostrar tus propios productos.</p>
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-3 lg:gap-4">
                <AnimatePresence>
                  {items.map((item, idx) => (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ delay: idx * 0.05 }}
                      className="group bg-[#141414] border border-white/5 rounded-2xl overflow-hidden hover:border-emerald-500/30 transition-all hover:bg-[#1a1a1a]"
                    >
                      <div className="aspect-[3/4] relative overflow-hidden bg-black flex items-center justify-center">
                        {item.photo?.url ? (
                          <img 
                            src={item.photo.url} 
                            alt={item.title} 
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="w-full h-full bg-white/5 flex items-center justify-center">
                            <User className="w-8 h-8 text-white/10" />
                          </div>
                        )}
                        
                        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-4">
                          <div className="flex gap-2">
                            <a 
                              href={item.url} 
                              target="_blank" 
                              rel="noreferrer"
                              className="flex-1 bg-white/10 backdrop-blur-md text-white border border-white/20 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-2 hover:bg-white/20 transition-colors"
                            >
                              Ver en Vinted <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        </div>

                        {item.is_hidden && (
                          <div className="absolute top-3 right-3 bg-red-500 text-black px-2 py-1 rounded text-[10px] font-bold uppercase tracking-tight shadow-xl">
                            Oculto
                          </div>
                        )}
                      </div>

                      <div className="p-4">
                        <div className="flex justify-between items-start gap-2 mb-1">
                          <h3 className="text-sm font-medium leading-tight truncate flex-1">{item.title}</h3>
                          <span className="text-emerald-400 font-mono text-sm font-bold">
                            {item.price?.amount} {item.price?.currency_code}
                          </span>
                        </div>
                        <p className="text-[10px] text-white/30 uppercase tracking-wider mb-4">ID: {item.id}</p>
                        
                        <button 
                          onClick={() => toggleVisibility(item.id, !!item.is_hidden)}
                          className={`w-full py-2.5 rounded-xl flex items-center justify-center gap-2 text-xs font-bold transition-all ${
                            item.is_hidden 
                              ? 'bg-emerald-500 text-black hover:bg-emerald-400' 
                              : 'bg-white/5 text-white/60 hover:bg-white/10 border border-white/5'
                          }`}
                        >
                          {item.is_hidden ? (
                            <>
                              <Eye className="w-4 h-4" /> Mostrar Producto
                            </>
                          ) : (
                            <>
                              <EyeOff className="w-4 h-4" /> Ocultar Producto
                            </>
                          )}
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </>
          )}

          {activeTab === 'external' && (
            <motion.div 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="bg-[#141414] border border-white/5 rounded-3xl p-8 shadow-2xl space-y-8"
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-red-500/10 rounded-2xl flex items-center justify-center border border-red-500/20">
                  <EyeOff className="w-6 h-6 text-red-500" />
                </div>
                <div>
                  <h3 className="text-lg font-bold">Ocultar Productos Ajenos</h3>
                  <p className="text-xs text-white/40">Fuerza la ocultación temporal enviando un reporte de seguridad a Vinted.</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div>
                    <label className="block text-[10px] uppercase tracking-wider text-white/30 mb-2 ml-1">URL del Producto a Ocultar</label>
                    <div className="flex gap-2">
                      <input 
                        type="text" 
                        placeholder="https://www.vinted.es/items/123-titulo..."
                        value={externalUrl}
                        onChange={(e) => setExternalUrl(e.target.value)}
                        className="flex-1 bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-red-500/50 transition-colors"
                      />
                      <button 
                        onClick={resolveProductId}
                        className="px-4 bg-white/5 hover:bg-white/10 text-white rounded-xl transition-all border border-white/10"
                      >
                        Detectar ID
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] uppercase tracking-wider text-white/30 mb-2 ml-1">Motivo del Reporte (Trigger AI)</label>
                    <select 
                      value={reportReason}
                      onChange={(e) => setReportReason(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-red-500/50 transition-colors appearance-none cursor-pointer"
                    >
                      <option value="1">Falsificación (Fuerza revisión)</option>
                      <option value="4">Artículo Prohibido</option>
                      <option value="7">Spam / Estafa</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[10px] uppercase tracking-wider text-white/30 mb-2 ml-1">Descripción del Reporte (Stealth Payload)</label>
                    <div className="flex flex-wrap gap-2 mb-2">
                       {STEALTH_TEMPLATES.map(t => (
                         <button 
                           key={t.label} 
                           onClick={() => setStealthDescription(t.text)}
                           className="text-[9px] px-2 py-1 bg-white/5 hover:bg-white/10 rounded border border-white/10 text-white/50 hover:text-white"
                         >
                           {t.label}
                         </button>
                       ))}
                    </div>
                    <textarea 
                      value={stealthDescription}
                      onChange={(e) => setStealthDescription(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-red-500/50 transition-colors h-24 resize-none font-mono text-[11px] leading-relaxed"
                    />
                  </div>
                </div>

                <div className="bg-black/40 rounded-2xl p-6 border border-white/5 flex flex-col justify-center text-center relative overflow-hidden">
                  {externalId ? (
                    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                       <div className="flex items-center justify-center gap-2 mb-2">
                          <div className={`w-2 h-2 rounded-full ${itemStats.checked ? (itemStats.visible ? 'bg-emerald-500' : 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]') : 'bg-white/20'}`} />
                          <span className="text-[10px] uppercase tracking-[0.2em] font-bold">
                            {itemStats.checked ? (itemStats.visible ? 'En Venta' : 'OCULTO / ELIMINADO') : 'Objetivo Detectado'}
                          </span>
                       </div>
                       
                       <h4 className="text-xl font-bold truncate px-4">{externalTitle}</h4>
                       
                       <div className="flex items-center justify-center gap-4">
                         <div className="text-xs font-mono text-white/30 px-3 py-1 bg-white/5 rounded-full">ID: {externalId}</div>
                         <button onClick={checkPublicStatus} title="Verificar visibilidad" className="text-white/20 hover:text-white transition-colors">
                           <RefreshCcw className="w-4 h-4" />
                         </button>
                       </div>

                        <div className="grid grid-cols-1 gap-3 mt-4">
                          <button 
                           onClick={spamCheckout}
                           disabled={loading}
                           className="w-full bg-emerald-500 text-black font-bold py-5 rounded-2xl hover:bg-emerald-400 transition-all shadow-[0_0_30px_rgba(16,185,129,0.3)] flex flex-col items-center justify-center gap-1 border-2 border-emerald-400/50"
                          >
                           <div className="flex items-center gap-2">
                             <ShieldCheck className="w-6 h-6" />
                             <span className="text-lg">FORCE HIDE ATTACK</span>
                           </div>
                           <span className="text-[11px] opacity-70 font-normal uppercase tracking-wider">Metodo Checkout Spam (Masivo)</span>
                          </button>

                          <div className="grid grid-cols-2 gap-2">
                            <button 
                             onClick={reportItem}
                             disabled={loading}
                             className="py-3 bg-red-600/20 text-red-400 rounded-xl border border-red-500/20 text-xs font-bold hover:bg-red-600/30 transition-all"
                            >
                             Reporte V1
                            </button>
                            <button 
                             onClick={checkPublicStatus}
                             className="py-3 bg-white/5 text-white/40 rounded-xl border border-white/10 text-xs font-bold hover:bg-white/10 transition-all"
                            >
                             Verificar
                            </button>
                          </div>
                        </div>
                       
                       {!itemStats.visible && itemStats.checked && (
                         <motion.div 
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          className="mt-4 p-3 bg-red-500/20 rounded-xl border border-red-500/30 text-red-400 text-xs font-bold"
                         >
                            <ShieldCheck className="w-4 h-4 mx-auto mb-1" />
                            ITEM ELIMINADO DE LA BÚSQUEDA
                         </motion.div>
                       )}
                    </div>
                  ) : (
                    <div className="text-white/20">
                      <Search className="w-12 h-12 mx-auto mb-4 opacity-10" />
                      <p className="text-sm">Introduce la URL del producto objetivo para proceder</p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </div>
        {activeTab === 'profits' && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <div className="space-y-2">
              <h2 className="text-3xl md:text-4xl font-black tracking-tighter text-white">
                CONTROL DE <span className="text-emerald-500 italic">BENEFICIOS</span>
              </h2>
              <p className="text-sm text-white/40 font-medium uppercase tracking-[0.3em]">Facturación · Gastos · Net Profit</p>
            </div>
            <ProfitControl token={token} />
          </motion.div>
        )}

        {activeTab === 'tongues' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            <div className="bg-[#0f0f0f] border border-white/5 rounded-[2.5rem] p-8 md:p-12 shadow-2xl relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-8 opacity-5">
                <Scissors className="w-32 h-32 text-emerald-500" />
              </div>
              
              <div className="relative z-10 space-y-8">
                <div className="space-y-2">
                  <h2 className="text-3xl md:text-5xl font-black tracking-tighter text-white">
                    EDITOR DE <span className="text-emerald-500 italic underline decoration-white/10 underline-offset-8">LENGÜETAS</span>
                  </h2>
                  <p className="text-sm text-white/40 font-medium uppercase tracking-[0.3em]">IA Vision • Reconstrucción Forense</p>
                </div>

                <TongueEditor />
              </div>
            </div>
          </motion.div>
        )}
      </main>

      {/* API Reference Modal-like section at bottom */}
      <footer className="max-w-7xl mx-auto px-6 py-12 border-t border-white/5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <div>
            <h4 className="text-white/40 uppercase tracking-[0.2em] text-[10px] mb-4">Integración API</h4>
            <p className="text-sm text-white/60 mb-6">Puedes usar estos endpoints directamente desde tu propia aplicación para automatizar el modo oculto.</p>
            
            <div className="space-y-4">
              <div className="bg-black border border-white/5 rounded-xl p-4 font-mono text-xs overflow-x-auto">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-emerald-400">POST /api/vinted/hide</span>
                  <button onClick={() => copyToClipboard('curl -X POST /api/vinted/hide -d \'{"itemId": 123, "cookie": "..."}\'')} className="hover:text-emerald-400">
                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  </button>
                </div>
                <code className="text-white/40 leading-6">{"{"}</code><br/>
                <code className="pl-4 text-emerald-300">"itemId": 1234567,</code><br/>
                <code className="pl-4 text-emerald-300">"cookie": "string"</code><br/>
                <code className="text-white/40 leading-6">{"}"}</code>
              </div>
            </div>
          </div>

          <div className="bg-[#141414] rounded-3xl p-8 border border-white/5 relative overflow-hidden">
            <div className="absolute -right-4 -bottom-4 w-32 h-32 bg-emerald-500/5 blur-3xl rounded-full" />
            <h4 className="text-lg font-bold mb-2">Seguridad y Privacidad</h4>
            <p className="text-sm text-white/40 leading-relaxed">
              Esta herramienta no almacena tus cookies permanentemente en el servidor. 
              Toda la comunicación se realiza a través de un proxy local seguro. 
              Asegúrate de no compartir nunca tu cookie de sesión pública.
            </p>
            <div className="mt-6 flex items-center gap-2 text-emerald-400/50 text-[10px] uppercase font-bold tracking-widest">
              <CheckCircle2 className="w-4 h-4" /> Cifrado de extremo a extremo activo
            </div>
          </div>
        </div>
        
        <div className="mt-20 pt-8 border-t border-white/5 text-center">
          <p className="text-[10px] text-white/20 uppercase tracking-[0.3em]">Vinted Stealth Manager &copy; 2026 • Security Division</p>
        </div>
      </footer>
    </div>
  );
}
