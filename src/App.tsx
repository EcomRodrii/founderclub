import React, { useState, useEffect, useCallback } from 'react';
import {
  Eye, EyeOff, Search, Settings,
  Lock, User, ExternalLink, RefreshCcw,
  CheckCircle2, AlertCircle, ShieldCheck,
  ChevronRight, LayoutGrid, List as ListIcon,
  HelpCircle, Copy, Check, Scissors, Key, LogOut, TrendingUp,
  Image as ImageIcon, Terminal as TerminalIcon
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import TongueEditor from './components/TongueEditor';
import AuthPage from './components/AuthPage';
import AdminPanel from './components/AdminPanel';
import ProfitControl from './components/ProfitControl';
import ImageUniquifier from './components/ImageUniquifier';

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
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-[20px] bg-[#4d9fff]/10 border border-[#4d9fff]/25 mb-4">
            <Key className="w-8 h-8 text-acid" />
          </div>
          <h1 className="text-2xl font-bold text-[#f4f4ef]">Activar licencia</h1>
          <p className="text-muted text-sm mt-1">Introduce tu clave para acceder</p>
        </div>
        <div className="bg-panel border border-white/8 rounded-[28px] p-6">
          {success ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <CheckCircle2 className="w-12 h-12 text-acid" />
              <p className="text-[#f4f4ef] font-medium">¡Licencia activada!</p>
            </div>
          ) : (
            <form onSubmit={activate} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Clave de licencia</label>
                <input
                  type="text"
                  value={key}
                  onChange={e => setKey(e.target.value.toUpperCase())}
                  placeholder="FC-XXXX-XXXX-XXXX-XXXX"
                  required
                  className="w-full bg-panel-soft border border-white/8 rounded-[14px] px-4 py-2.5 text-sm font-mono text-[#f4f4ef] placeholder-[#a4a79f] focus:outline-none focus:border-[#4d9fff]/35 transition"
                />
              </div>
              {error && (
                <div className="flex items-center gap-2 bg-[#ff9797]/8 border border-[#ff9797]/20 rounded-[14px] px-3 py-2.5 text-sm text-[#ff9797]">
                  <AlertCircle className="w-4 h-4 shrink-0" />{error}
                </div>
              )}
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-acid hover:bg-acid-2 disabled:opacity-50 text-[#050607] font-semibold rounded-[14px] py-2.5 text-sm transition shadow-acid"
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
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-acid border-t-transparent rounded-full animate-spin" />
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

  // Compartir token con la extensión Chrome (si está instalada) para que no
  // haga falta hacer login dos veces. La extensión escucha el evento
  // 'founderclub-token' en window y lo guarda como lamine_auth_token.
  useEffect(() => {
    if (!token) return;
    window.dispatchEvent(new CustomEvent('founderclub-token', { detail: { token } }));
  }, [token]);

  // Helper to add auth to fetch calls
  const apiFetch = (url: string, options: RequestInit = {}) =>
    fetch(url, { ...options, headers: { ...options.headers as any, ...authHeader } });
  const [cookie, setCookie] = useState<string>(() => localStorage.getItem('vinted_cookie') || '');
  const [userId, setUserId] = useState<string>(() => localStorage.getItem('vinted_user_id') || '3152763908');
  const [domain, setDomain] = useState<string>(() => localStorage.getItem('vinted_domain') || 'es');
  const [profileUrl, setProfileUrl] = useState('https://www.vinted.es/member/3152763908');
  const [activeTab, setActiveTab] = useState<'mine' | 'tongues' | 'profits' | 'photos'>('mine');
  
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

    if (cookie?.includes('_vinted_fr_')) setDomain('fr');
    else if (cookie?.includes('_vinted_it_')) setDomain('it');
    else if (cookie?.includes('_vinted_es_')) setDomain('es');
  }, [cookie, userId, domain]);

  const validateSession = async () => {
    if (!cookie) return;
    try {
      const res = await fetch('/api/vinted/check-session', {
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
        setStatus(`Sesión inválida`);
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

        if (rawDetail === undefined || rawDetail === null) {
          detailMessage = '';
        } else if (typeof rawDetail === 'string') {
          if (rawDetail.includes('<html')) {
            detailMessage = 'Vinted devolvió una página de error HTML (404/Block). Verifica que el ID de usuario sea correcto para el dominio seleccionado.';
          } else {
            detailMessage = rawDetail;
          }
        } else {
          detailMessage = JSON.stringify(rawDetail);
        }

        setError(detailMessage ? `${data.error || 'Error'}: ${detailMessage}` : (data.error || 'Error desconocido'));
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


  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen text-[var(--color-text)] font-sans selection:bg-[var(--color-acid-soft)] selection:text-[var(--color-acid)]">
      {/* Top Banner pill — estilo Lamine Hub */}
      <div className="sticky top-3 z-50 mx-auto" style={{ width: 'min(1120px, calc(100% - 24px))' }}>
        <nav className="flex items-center justify-between gap-3 px-4 lg:px-6 py-3 rounded-full border border-white/[0.16] bg-[rgba(12,14,16,0.76)] backdrop-blur-xl shadow-[0_20px_60px_rgba(0,0,0,0.38)]">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-2.5 h-2.5 rounded-[3px] bg-acid shadow-[0_0_20px_rgba(77,159,255,0.55)] shrink-0" />
            <span className="font-display text-[1.45rem] lg:text-[1.7rem] leading-none tracking-[0.08em] text-[var(--color-text)] truncate">
              FOUNDERCLUB
            </span>
          </div>

          <div className="flex items-center gap-2 lg:gap-3">
            <span className={`w-2 h-2 rounded-full shrink-0 ${sessionValid === true ? 'bg-acid shadow-[0_0_8px_rgba(77,159,255,0.6)]' : sessionValid === false ? 'bg-[var(--color-danger)]' : 'bg-white/20'}`} />
            <span className={`hidden sm:inline text-[11px] font-mono uppercase tracking-wider ${sessionValid === true ? 'text-acid' : sessionValid === false ? 'text-[var(--color-danger)]' : 'text-white/40'}`}>
              {sessionValid === true ? 'Active' : sessionValid === false ? 'Expired' : '...'}
            </span>
            <span className="hidden lg:inline text-[11px] text-white/40 font-mono px-2">{user.username}</span>
            <button
              onClick={() => setShowCookieHelp(!showCookieHelp)}
              className="hidden lg:flex w-9 h-9 items-center justify-center rounded-full border border-white/10 text-white/55 hover:text-acid hover:border-acid transition ease-hub"
              title="Ayuda"
            >
              <HelpCircle className="w-4 h-4" />
            </button>
            {onAdmin && (
              <button
                onClick={onAdmin}
                title="Panel de Admin"
                className="hidden lg:flex w-9 h-9 items-center justify-center rounded-full border border-white/10 text-white/55 hover:text-acid hover:border-acid transition ease-hub"
              >
                <ShieldCheck className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={onLogout}
              title="Cerrar sesión"
              className="w-9 h-9 flex items-center justify-center rounded-full border border-white/10 text-white/55 hover:text-[var(--color-danger)] hover:border-[rgba(255,143,143,0.45)] transition ease-hub"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </nav>
      </div>

      <div className="h-3" />


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
              className="fixed bottom-16 left-0 right-0 z-50 bg-[#141414] border-t border-white/10 rounded-t-3xl p-5 pb-safe max-h-[75vh] overflow-y-auto lg:hidden"
            >
              <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />
              <div className="space-y-4">
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-white/30 mb-1.5 ml-1">Dominio Vinted</label>
                  <select value={domain} onChange={e => setDomain(e.target.value)}
                    className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-3 text-sm focus:outline-none focus:border-acid appearance-none">
                    {DOMAINS.map(d => <option key={d} value={d}>vinted.{d}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-white/30 mb-1.5 ml-1">URL de perfil</label>
                  <div className="flex gap-2">
                    <input type="text" placeholder="https://www.vinted.es/member/..."
                      value={profileUrl} onChange={e => setProfileUrl(e.target.value)}
                      className="flex-1 bg-black/30 border border-white/10 rounded-lg px-3 py-3 text-sm focus:outline-none focus:border-acid" />
                    <button onClick={() => { resolveUserId(); setMobileSidebarOpen(false); }}
                      className="p-3 bg-acid-soft text-acid rounded-lg border border-acid">
                      <Search className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-white/30 mb-1.5 ml-1">Cookie de sesión</label>
                  <textarea value={cookie} onChange={e => setCookie(e.target.value)}
                    placeholder="_vinted_fr_session=..."
                    className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-3 text-sm font-mono h-24 resize-none focus:outline-none focus:border-acid" />
                </div>
                <button onClick={() => { fetchItems(); setMobileSidebarOpen(false); }} disabled={loading}
                  className="w-full bg-acid text-black font-bold py-3.5 rounded-xl hover:bg-acid transition-all flex items-center justify-center gap-2 disabled:opacity-50 text-base">
                  {loading ? <RefreshCcw className="w-5 h-5 animate-spin" /> : <LayoutGrid className="w-5 h-5" />}
                  Cargar inventario
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Mobile bottom navigation */}
      <div className="fixed bottom-0 left-0 right-0 z-40 lg:hidden bg-[rgba(12,14,16,0.92)] backdrop-blur-xl border-t border-white/[0.08]">
        <div className="flex items-center justify-around px-2 py-2 pb-safe">
          {[
            { id: 'config', icon: <Settings className="w-5 h-5" />, label: 'Config', action: () => setMobileSidebarOpen(o => !o) },
            { id: 'profits', icon: <TrendingUp className="w-5 h-5" />, label: 'Control', action: () => { setActiveTab('profits'); setMobileSidebarOpen(false); } },
            { id: 'tongues', icon: <Scissors className="w-5 h-5" />, label: 'Lengüeta', action: () => { setActiveTab('tongues'); setMobileSidebarOpen(false); } },
            { id: 'photos', icon: <ImageIcon className="w-5 h-5" />, label: 'Fotos', action: () => { setActiveTab('photos'); setMobileSidebarOpen(false); } },
          ].map(item => {
            const isActive = item.id === 'config' ? mobileSidebarOpen : (item.id !== 'config' && activeTab === item.id);
            return (
              <button key={item.id} onClick={item.action}
                className={`flex flex-col items-center gap-1 px-2 py-1.5 rounded-xl transition-all ${isActive ? 'text-acid' : 'text-muted'}`}>
                {item.icon}
                <span className="text-[10px] font-medium uppercase tracking-wider">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <main className={`max-w-7xl mx-auto px-3 py-4 lg:p-6 pb-24 lg:pb-6 grid grid-cols-1 gap-8 ${['profits','tongues','photos'].includes(activeTab) ? '' : 'lg:grid-cols-[380px_1fr]'}`}>
        {/* Sidebar Configuration — desktop only, oculta en pestañas de pantalla completa */}
        <div className={`space-y-6 ${['profits','tongues','photos'].includes(activeTab) ? 'hidden' : 'hidden lg:block'}`}>
          <section className="bg-[#141414] border border-white/5 rounded-2xl p-6 shadow-xl relative overflow-hidden group">
            <div className="absolute top-0 left-0 w-1 h-full bg-acid opacity-50 group-hover:opacity-100 transition-opacity" />
            
            <div className="flex items-center gap-2 mb-6">
              <Settings className="w-4 h-4 text-acid" />
              <h2 className="text-xs uppercase tracking-widest font-bold text-white/50">Configuración de Acceso</h2>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-white/30 mb-1.5 ml-1">Dominio Vinted</label>
                <select 
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-acid transition-colors appearance-none cursor-pointer hover:bg-black/50"
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
                    className="flex-1 bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-acid transition-colors"
                  />
                  <button 
                    onClick={resolveUserId}
                    className="p-2 bg-acid-soft text-acid rounded-lg hover:bg-acid/20 transition-colors border border-acid"
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
                    className={`w-full bg-black/30 border ${cookieWarning ? 'border-red-500/50' : 'border-white/10'} rounded-lg pl-10 pr-3 py-3 text-sm focus:outline-none focus:border-acid transition-colors h-24 font-mono resize-none`}
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
                  className="w-full bg-acid text-black font-bold py-3 rounded-xl hover:bg-acid transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-acid"
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
              className="bg-acid-soft border border-acid rounded-2xl p-6 text-sm leading-relaxed"
            >
              <h3 className="text-acid font-bold mb-4 flex items-center gap-2">
                <HelpCircle className="w-4 h-4" /> ¿Cómo obtener la Cookie de Sesión?
              </h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <p className="text-xs font-bold text-white/80">Opción A: Método Rápido</p>
                  <ol className="list-decimal list-inside space-y-2 text-[11px] text-white/50">
                    <li>Entra en <span className="text-white">vinted.es</span> y logueate.</li>
                    <li>Presiona <kbd className="bg-white/10 px-1 rounded border border-white/20">F12</kbd> y ve a la pestaña <span className="text-white">Consola</span>.</li>
                    <li>Escribe <code className="text-acid">copy(document.cookie)</code> y dale al Enter.</li>
                    <li>
                      <button 
                        onClick={() => copyToClipboard('copy(document.cookie)')}
                        className="mt-2 flex items-center gap-2 px-3 py-1.5 bg-acid-soft hover:bg-acid/30 border border-acid rounded-lg text-[10px] text-acid transition-all"
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
                    <li>En la sección <span className="text-white">Request Headers</span>, copia el valor de <span className="text-acid">Cookie</span>.</li>
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
              <p className="hidden lg:block font-display text-[0.8rem] tracking-[0.3em] text-acid">PANEL DE CONTROL</p>
              <h2 className="hidden lg:block font-display text-[2.2rem] leading-none tracking-[0.02em] text-[var(--color-text)] mt-1">Founder Hub</h2>
              <div className="hidden lg:flex flex-wrap gap-2 mt-4">
                {[
                  { id: 'mine', label: 'Mis Productos' },
                  { id: 'tongues', label: 'Cambiar Lengüeta' },
                  { id: 'photos', label: 'Fotos Únicas' },
                  { id: 'profits', label: 'Beneficios' },
                ].map(t => (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id as any)}
                    className={`px-4 min-h-[40px] rounded-full text-[0.78rem] font-bold uppercase tracking-[0.14em] border transition ease-hub ${
                      activeTab === t.id
                        ? 'bg-acid-soft border-acid text-acid'
                        : 'bg-white/[0.03] border-white/10 text-muted-strong hover:border-acid hover:text-acid'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {activeTab === 'mine' && (
              <div className="flex bg-white/[0.03] rounded-full p-1 border border-white/10 self-start sm:self-auto">
                <button className="p-2 bg-acid-soft text-acid rounded-full border border-acid">
                  <LayoutGrid className="w-4 h-4" />
                </button>
                <button className="p-2 text-muted hover:text-acid transition-colors rounded-full">
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
                      className="group bg-[#141414] border border-white/5 rounded-2xl overflow-hidden hover:border-acid/30 transition-all hover:bg-[#1a1a1a]"
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
                          <span className="text-acid font-mono text-sm font-bold">
                            {item.price?.amount} {item.price?.currency_code}
                          </span>
                        </div>
                        <p className="text-[10px] text-white/30 uppercase tracking-wider mb-4">ID: {item.id}</p>
                        
                        {/* Ocultar / Mostrar */}
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => toggleVisibility(item.id, !!item.is_hidden)}
                            className={`flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 text-xs font-bold transition-all ${
                              item.is_hidden
                                ? 'bg-acid text-black hover:bg-acid'
                                : 'bg-white/5 text-white/60 hover:bg-white/10 border border-white/5'
                            }`}
                          >
                            {item.is_hidden ? <><Eye className="w-3 h-3" /> Mostrar</> : <><EyeOff className="w-3 h-3" /> Ocultar</>}
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </>
          )}

          {activeTab === 'profits' && (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
              <div className="space-y-2">
                <h2 className="text-3xl md:text-4xl font-display tracking-[0.02em] text-white">
                  CONTROL DE <span className="text-acid">BENEFICIOS</span>
                </h2>
                <p className="text-sm text-white/40 font-medium uppercase tracking-[0.3em]">Facturación · Gastos · Net Profit</p>
              </div>
              <ProfitControl token={token} />
            </motion.div>
          )}

          {activeTab === 'tongues' && (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
              <div className="bg-[#0f0f0f] border border-white/5 rounded-[2.5rem] p-8 md:p-12 shadow-2xl relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-8 opacity-5">
                  <Scissors className="w-32 h-32 text-acid" />
                </div>
                <div className="relative z-10 space-y-8">
                  <div className="space-y-2">
                    <h2 className="text-3xl md:text-5xl font-display tracking-[0.02em] text-white">
                      EDITOR DE <span className="text-acid underline decoration-white/10 underline-offset-8">LENGÜETAS</span>
                    </h2>
                    <p className="text-sm text-white/40 font-medium uppercase tracking-[0.3em]">IA Vision • Reconstrucción Forense</p>
                  </div>
                  <TongueEditor />
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'photos' && (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
              <div className="space-y-2">
                <h2 className="text-3xl md:text-4xl font-display tracking-[0.02em] text-white">
                  FOTOS <span className="text-acid">ÚNICAS</span>
                </h2>
                <p className="text-sm text-white/40 font-medium uppercase tracking-[0.3em]">Anti-Detección · Hash Único · Sin EXIF</p>
              </div>
              <ImageUniquifier />
            </motion.div>
          )}

        </div>
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
                  <span className="text-acid">POST /api/vinted/hide</span>
                  <button onClick={() => copyToClipboard('curl -X POST /api/vinted/hide -d \'{"itemId": 123, "cookie": "..."}\'')} className="hover:text-acid">
                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  </button>
                </div>
                <code className="text-white/40 leading-6">{"{"}</code><br/>
                <code className="pl-4 text-acid">"itemId": 1234567,</code><br/>
                <code className="pl-4 text-acid">"cookie": "string"</code><br/>
                <code className="text-white/40 leading-6">{"}"}</code>
              </div>
            </div>
          </div>

          <div className="bg-[#141414] rounded-3xl p-8 border border-white/5 relative overflow-hidden">
            <div className="absolute -right-4 -bottom-4 w-32 h-32 bg-acid-soft blur-3xl rounded-full" />
            <h4 className="text-lg font-bold mb-2">Seguridad y Privacidad</h4>
            <p className="text-sm text-white/40 leading-relaxed">
              Esta herramienta no almacena tus cookies permanentemente en el servidor. 
              Toda la comunicación se realiza a través de un proxy local seguro. 
              Asegúrate de no compartir nunca tu cookie de sesión pública.
            </p>
            <div className="mt-6 flex items-center gap-2 text-acid text-[10px] uppercase font-bold tracking-widest">
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

