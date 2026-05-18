import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Eye, EyeOff, Search, Settings,
  Lock, User, ExternalLink, RefreshCcw,
  CheckCircle2, AlertCircle, ShieldCheck,
  ChevronRight, LayoutGrid, List as ListIcon,
  HelpCircle, Copy, Check, Scissors, Key, LogOut, TrendingUp, Zap, Trash2,
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
  const [goolazoCookie, setGoolazoCookie] = useState<string>(() => localStorage.getItem('goolazo_cookie') || '');
  const [bsEmail, setBsEmail] = useState('');
  const [bsPassword, setBsPassword] = useState('');
  const [bsLoginLoading, setBsLoginLoading] = useState(false);
  const [bsLoginMsg, setBsLoginMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [userId, setUserId] = useState<string>(() => localStorage.getItem('vinted_user_id') || '3152763908');
  const [domain, setDomain] = useState<string>(() => localStorage.getItem('vinted_domain') || 'es');
  const [profileUrl, setProfileUrl] = useState('https://www.vinted.es/member/3152763908');
  const [activeTab, setActiveTab] = useState<'mine' | 'external' | 'tongues' | 'profits' | 'photos'>('mine');
  
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
    localStorage.setItem('goolazo_cookie', goolazoCookie);
  }, [goolazoCookie]);

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

  const resolveProductId = async () => {
    if (!externalUrl) return;
    // Extraer ID directo de la URL sin llamada al servidor
    const quickId =
      externalUrl.match(/\/items\/(\d+)/i)?.[1] ||
      externalUrl.match(/\/(\d{5,})-/)?.[1] ||
      externalUrl.match(/\/(\d{5,})\/?(?:[?#]|$)/)?.[1] ||
      null;
    if (quickId) {
      setExternalId(quickId);
      setExternalTitle('Producto detectado');
      setStatus('ID detectado: ' + quickId);
      return;
    }
    // Fallback al servidor solo si el regex no funciona
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

  const [itemStats, setItemStats] = useState<{ visible: boolean; checked: boolean }>({ visible: true, checked: false });
  const [stealthDescription, setStealthDescription] = useState('This item is a replica and uses stock photos from a luxury brand website. Selling counterfeits is against Vinted safety policies.');

  // Bazooka queue
  interface BazookaJob { id: number; url: string; title: string | null; item_id: string; status: string; note: string | null; error_message: string | null; created_at: string; }
  interface SniperResult { worker: number; success: boolean; transactionId?: string; purchaseId?: string; error?: string; durationMs: number; }
  const [bazookaJobs, setBazookaJobs] = useState<BazookaJob[]>([]);

  // Auto-Bazooka (extensión)
  const [bazookaAuto, setBazookaAuto]     = useState<{ enabled: boolean; maxPrice: number }>({ enabled: false, maxPrice: 0 });
  const [bazookaAutoMaxPrice, setBazookaAutoMaxPrice] = useState('0');
  const [bazookaAutoSaving, setBazookaAutoSaving]     = useState(false);
  const [loadingReserve, setLoadingReserve] = useState(false);
  const [sniperLoading, setSniperLoading] = useState(false);
  const [bombardeoLoading, setBombardeoLoading] = useState(false);
  const [sniperResult, setSniperResult] = useState<{ ok: boolean; itemId: string; sellerId: string; title: string; workers: number; winner: SniperResult | null; results: SniperResult[]; fastestMs: number } | null>(null);

  // ── Auto-repeat ──
  const [autoRepeat, setAutoRepeat] = useState(false);
  const [repeatInterval, setRepeatInterval] = useState(5); // minutos
  const [repeatCountdown, setRepeatCountdown] = useState<number | null>(null);
  const [repeatAttackType, setRepeatAttackType] = useState<string | null>(null);

  // ── Ops terminal ──
  interface TermLine { id: string; ts: Date; level: 'sys'|'ok'|'err'|'warn'|'http'|'worker'|'data'; tag: string; msg: string; }
  const [termLines, setTermLines] = useState<TermLine[]>([]);
  const termRef = useRef<HTMLDivElement>(null);
  const term = useCallback((level: TermLine['level'], tag: string, msg: string) => {
    setTermLines(prev => [...prev, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, ts: new Date(), level, tag, msg }].slice(-500));
  }, []);
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [termLines]);

  // ── SSE live stream (ops-stream) ──────────────────────────────────────────
  const sseRef = useRef<EventSource | null>(null);
  useEffect(() => {
    if (activeTab !== 'external') {
      sseRef.current?.close();
      sseRef.current = null;
      return;
    }
    // Close any existing connection before opening a new one
    sseRef.current?.close();
    const es = new EventSource(`/api/ops-stream?token=${encodeURIComponent(token)}`);
    sseRef.current = es;
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.tag && d.msg) term(d.level as TermLine['level'] || 'sys', d.tag, d.msg);
      } catch {}
    };
    es.onerror = () => term('warn', 'STREAM', 'conexión perdida · reconectando…');
    return () => { es.close(); sseRef.current = null; };
  }, [activeTab, token]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Attack log (kept for compat) ──
  interface AttackEntry { id: string; type: string; itemId: string; title: string; success: boolean; detail: string; at: Date; }
  const [attackLog, setAttackLog] = useState<AttackEntry[]>([]);
  const addLog = (entry: Omit<AttackEntry, 'id'>) => {
    setAttackLog(prev => [{ ...entry, id: Date.now().toString() }, ...prev].slice(0, 25));
  };

  // ── Seller bulk mode ──
  const [sellerUrl, setSellerUrl] = useState('');
  const [sellerItems, setSellerItems] = useState<any[]>([]);
  const [sellerLoading, setSellerLoading] = useState(false);
  const [sellerAttacking, setSellerAttacking] = useState(false);

  // ── Multi-target ──
  const [multiUrls, setMultiUrls] = useState('');
  const [multiLoading, setMultiLoading] = useState(false);

  // ── Advanced config panel ──
  const [showAdvanced, setShowAdvanced] = useState(false);

  const loadJobs = useCallback(async () => {
    try {
      const r = await apiFetch('/api/bazooka/jobs');
      if (r.ok) setBazookaJobs(await r.json());
    } catch {}
  }, []);

  useEffect(() => {
    if (activeTab !== 'external') return;
    loadJobs();
    const iv = setInterval(loadJobs, 4000);
    // Terminal init message
    term('sys', 'SYS', `lamine-ops terminal · v1.1 · cookie:${cookie ? 'OK' : 'AUSENTE'} · domain:${domain}`);
    term('sys', 'SYS', 'ready. esperando operaciones desde extension o UI...');
    return () => clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, loadJobs]);

  // ── Auto-repeat countdown ──────────────────────────────────────────────────
  useEffect(() => {
    if (!autoRepeat || repeatCountdown === null) return;
    if (repeatCountdown <= 0) {
      // Fire the stored attack type
      if (repeatAttackType === 'sniper') fireSniperBazooka();
      else if (repeatAttackType === 'bombardeo') spamCheckout();
      else if (repeatAttackType === 'reporte') reportItem();
      setRepeatCountdown(repeatInterval * 60);
      return;
    }
    const t = setTimeout(() => setRepeatCountdown(c => (c ?? 0) - 1), 1000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRepeat, repeatCountdown]);

  const fmtCountdown = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const toggleAutoRepeat = (type: string) => {
    if (autoRepeat && repeatAttackType === type) {
      setAutoRepeat(false);
      setRepeatCountdown(null);
      setRepeatAttackType(null);
    } else {
      setAutoRepeat(true);
      setRepeatAttackType(type);
      setRepeatCountdown(repeatInterval * 60);
    }
  };

  // ── Seller bulk ────────────────────────────────────────────────────────────
  const loadSellerItems = async () => {
    if (!sellerUrl) return;
    setSellerLoading(true);
    setSellerItems([]);
    try {
      const r = await fetch(`/api/vinted/seller-items?url=${encodeURIComponent(sellerUrl)}&domain=${domain}`);
      const d = await r.json();
      setSellerItems(d.items || []);
      if (!d.items?.length) setError('No se encontraron artículos activos para ese vendedor.');
    } catch { setError('Error al cargar artículos del vendedor.'); }
    finally { setSellerLoading(false); }
  };

  const attackSellerAll = async () => {
    if (!sellerItems.length) return;
    if (!cookie) { setError('⚠️ Cookie de Vinted requerida.'); return; }
    setSellerAttacking(true);
    setStatus(`🎯 Atacando ${sellerItems.length} artículos...`);
    let ok = 0;
    for (const item of sellerItems) {
      const itemUrl = item.url || `https://www.vinted.${domain}/items/${item.id}-${(item.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`;
      try {
        const r = await apiFetch('/api/sniper/fire', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: itemUrl, cookies: cookie, workers: 2 }) });
        const d = await r.json();
        if (d.ok) ok++;
        addLog({ type: 'sniper', itemId: String(item.id), title: item.title || '', success: d.ok, detail: d.ok ? `Sniper ${d.fastestMs}ms` : 'Fallido', at: new Date() });
      } catch {}
    }
    setSellerAttacking(false);
    setStatus(`✅ Bulk completado: ${ok}/${sellerItems.length} exitosos.`);
  };

  // ── Multi-target ───────────────────────────────────────────────────────────
  const attackMultiTargets = async () => {
    const urls = multiUrls.split('\n').map(u => u.trim()).filter(u => u.startsWith('http'));
    if (!urls.length) { setError('⚠️ Introduce al menos una URL.'); return; }
    if (!cookie) { setError('⚠️ Cookie de Vinted requerida.'); return; }
    setMultiLoading(true);
    setStatus(`🎯 Atacando ${urls.length} objetivos...`);
    let ok = 0;
    for (const u of urls) {
      try {
        const r = await apiFetch('/api/sniper/fire', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u, cookies: cookie, workers: 2 }) });
        const d = await r.json();
        if (d.ok) ok++;
        addLog({ type: 'sniper', itemId: d.itemId || u.match(/\/(\d{5,})-/)?.[1] || '?', title: d.title || u, success: d.ok, detail: d.ok ? `Sniper ${d.fastestMs}ms` : 'Fallido', at: new Date() });
      } catch {}
    }
    setMultiLoading(false);
    setStatus(`✅ Multi-target: ${ok}/${urls.length} exitosos.`);
  };

  const loginGoolazo = async () => {
    if (!bsEmail || !bsPassword) { setBsLoginMsg({ text: 'Introduce email y contraseña.', ok: false }); return; }
    setBsLoginLoading(true);
    setBsLoginMsg(null);
    try {
      const r = await apiFetch('/api/bazooka/goolazo-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: bsEmail, password: bsPassword }),
      });
      const d = await r.json();
      if (r.ok && d.ok && d.goolazoCookie) {
        setGoolazoCookie(d.goolazoCookie);
        setBsPassword('');
        setBsLoginMsg({ text: `✅ Sesión Goolazo iniciada como ${d.email}`, ok: true });
      } else {
        setBsLoginMsg({ text: `❌ ${d.error || 'Login fallido'}`, ok: false });
      }
    } catch {
      setBsLoginMsg({ text: '❌ Error de red al conectar con Goolazo.', ok: false });
    } finally {
      setBsLoginLoading(false);
    }
  };

  const enqueueReserve = async () => {
    const targetUrl = externalUrl;
    if (!targetUrl) { setError('⚠️ Introduce la URL del producto.'); return; }
    if (!cookie) { setError('⚠️ Se requieren cookies de Vinted.'); return; }
    // RESERVA usa el mismo flujo Blackstock que el Sniper
    setLoadingReserve(true);
    setStatus('🔗 Reservando item...');
    term('sys', 'SYS', `→ RESERVA · url:${targetUrl.replace(/\?.*/, '').slice(-50)} · workers:1`);
    try {
      const r = await apiFetch('/api/sniper/fire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl, cookies: cookie, workers: 1 }),
      });
      let d: any;
      try { d = await r.json(); } catch {
        term('err', 'RESERVA', `respuesta no-JSON del servidor (${r.status})`);
        setError(`❌ Respuesta inesperada (${r.status})`);
        return;
      }
      if (!r.ok) {
        term('err', 'RESERVA', `HTTP ${r.status} · ${d.error || 'error desconocido'}`);
        setError(`❌ ${d.error || 'Error desconocido'}`);
        return;
      }
      term('data', 'RESERVA', `item_id:${d.itemId || externalId} · fastest:${d.fastestMs}ms`);
      if (d.ok) {
        term('ok', 'RESERVA', `✓ RESERVADO · tx:${d.winner?.transactionId} · purchase:${d.winner?.purchaseId} · ${d.winner?.durationMs}ms`);
        setStatus(`✅ RESERVADO — tx:${d.winner?.transactionId} · purchase:${d.winner?.purchaseId}`);
        addLog({ type: 'sniper', itemId: d.itemId || externalId, title: d.title || externalTitle, success: true, detail: `Reserva OK ${d.fastestMs}ms`, at: new Date() });
      } else {
        const reasons = (d.results as any[])?.map((w: any) => w.error).filter(Boolean).join(' | ') || '';
        term('err', 'RESERVA', `✗ fallida · ${reasons}`);
        setError(`❌ Reserva fallida. ${reasons}`);
      }
    } catch (err: any) {
      term('err', 'RESERVA', `error de red: ${err?.message || 'desconocido'}`);
      setError(`❌ Error de red: ${err?.message}`);
    } finally {
      setLoadingReserve(false);
    }
  };

  const clearJobs = async () => {
    await apiFetch('/api/bazooka/jobs/clear', { method: 'DELETE' });
    setBazookaJobs([]);
  };

  // ── Auto-Bazooka: comunica con la extensión vía content script bridge ────────
  const sendToExtension = (action: string, payload: object = {}) =>
    new Promise<any>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 3000);
      const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (detail?.action === action) {
          clearTimeout(timeout);
          window.removeEventListener('founderclub-ext-response', handler);
          resolve(detail?.response ?? null);
        }
      };
      window.addEventListener('founderclub-ext-response', handler);
      window.dispatchEvent(new CustomEvent('founderclub-ext-msg', {
        detail: { action, ...payload }
      }));
    });

  const loadBazookaAuto = useCallback(async () => {
    try {
      const r = await sendToExtension('rb:bazooka-auto-get');
      if (r?.ok) {
        setBazookaAuto(r.bazookaAuto);
        setBazookaAutoMaxPrice(String(r.bazookaAuto.maxPrice || 0));
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (activeTab === 'external') loadBazookaAuto();
  }, [activeTab, loadBazookaAuto]);

  const saveBazookaAuto = async (enabled: boolean) => {
    setBazookaAutoSaving(true);
    try {
      const maxPrice = parseFloat(bazookaAutoMaxPrice) || 0;
      const next = { enabled, maxPrice };
      term('sys', 'EXT', `→ rb:bazooka-auto-set · enabled:${enabled} · maxPrice:${maxPrice}`);
      const r = await sendToExtension('rb:bazooka-auto-set', { bazookaAuto: next });
      if (r?.ok) {
        setBazookaAuto(next);
        term('ok', 'EXT', `auto-bazooka ${enabled ? 'ACTIVADO' : 'DESACTIVADO'} · maxPrice:${maxPrice}€`);
      } else {
        term('warn', 'EXT', `sin respuesta de extensión — recarga la extensión`);
      }
    } catch { term('err', 'EXT', 'error al contactar extensión'); }
    setBazookaAutoSaving(false);
  };

  const fireSniperBazooka = async () => {
    const targetUrl = externalUrl;
    if (!targetUrl) { setError('⚠️ Introduce la URL del producto.'); return; }
    if (!cookie) { setError('⚠️ Se requieren cookies de Vinted (access_token_web).'); return; }
    setSniperLoading(true);
    setSniperResult(null);
    setError(null);
    setStatus('🎯 Sniper cargando...');
    term('sys', 'SYS', `→ SNIPER · url:${targetUrl.replace(/\?.*/, '').slice(-50)} · workers:3`);
    try {
      const r = await apiFetch('/api/sniper/fire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl, cookies: cookie, workers: 3 }),
      });
      // Safe JSON parse — if server returns non-JSON (crash), show raw text
      let d: any;
      try {
        d = await r.json();
      } catch {
        const raw = await r.text().catch(() => `HTTP ${r.status}`);
        term('err', 'SNIPER', `respuesta no-JSON del servidor (${r.status}): ${raw.slice(0, 120)}`);
        setError(`❌ Respuesta inesperada del servidor (${r.status}): ${raw.slice(0, 200)}`);
        return;
      }
      if (!r.ok) {
        term('err', 'SNIPER', `HTTP ${r.status} · ${d.error || 'error desconocido'}`);
        setError(`❌ ${d.error || 'Error desconocido'}`);
        return;
      }
      setSniperResult(d);
      term('data', 'SNIPER', `item_id:${d.itemId || externalId} · seller_id:${d.sellerId || '?'} · fastest:${d.fastestMs}ms`);
      // Per-worker results
      (d.results as any[] || []).forEach((w: any) => {
        if (w.success) {
          term('worker', `W${w.worker}`, `✓ checkout OK · ${w.durationMs}ms · tx:${w.transactionId || '?'}`);
        } else {
          term('err', `W${w.worker}`, `✗ ${w.error?.slice(0, 80) || 'rechazado'}`);
        }
      });
      addLog({ type: 'sniper', itemId: d.itemId || externalId, title: d.title || externalTitle, success: d.ok, detail: d.ok ? `${d.winner?.worker} workers · ${d.fastestMs}ms` : 'Workers fallaron', at: new Date() });
      if (d.ok && d.winner) {
        term('ok', 'SNIPER', `🏆 GANADOR W${d.winner.worker} · ${d.winner.durationMs}ms · tx:${d.winner.transactionId} · purchase:${d.winner.purchaseId}`);
        setStatus(`✅ ITEM RESERVADO en ${d.winner.durationMs}ms — tx:${d.winner.transactionId} · purchase:${d.winner.purchaseId}`);
        setTimeout(checkPublicStatus, 4000);
      } else {
        const reasons = (d.results as any[])?.map((w: any) => `W${w.worker}:${w.error || 'rechazado'}`).join(' ') || '';
        term('err', 'SNIPER', `FALLIDO · ${reasons}`);
        setError(`❌ Workers fallaron. ${reasons}`);
      }
    } catch (err: any) {
      term('err', 'SNIPER', `error de red: ${err?.message || 'no se pudo conectar'}`);
      setError(`❌ Error de red: ${err?.message || 'No se pudo conectar con el servidor.'}`);
    }
    finally { setSniperLoading(false); }
  };


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
    term('sys', 'SYS', `→ REPORTE AI · item_id:${targetId} · reason:${reportReason} · domain:${domain}`);
    term('data', 'REPORTE', `payload: reasonId=${reportReason} · desc="${stealthDescription.slice(0, 40)}..."`);
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
        term('ok', 'REPORTE', `✓ aceptado · dominio:${data.domainUsed || domain} · AI review activo`);
        if (data.reportId) term('data', 'REPORTE', `report_id:${data.reportId}`);
        setStatus('Payload enviado. Vinted procesando revisión.');
        addLog({ type: 'reporte', itemId: targetId, title: externalTitle, success: true, detail: `Reason ${reportReason} · dominio: ${data.domainUsed || domain}`, at: new Date() });
        setTimeout(checkPublicStatus, 3000);
      } else {
        term('err', 'REPORTE', `✗ rechazado · ${data.details?.message || data.error || 'desconocido'}`);
        addLog({ type: 'reporte', itemId: targetId, title: externalTitle, success: false, detail: data.error || 'Rechazado', at: new Date() });
        setError('Error en la comunicación: ' + (data.details?.message || data.error));
      }
    } catch (err) {
      term('err', 'REPORTE', `error de red: ${(err as any)?.message || 'desconocido'}`);
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

    setBombardeoLoading(true);
    setLoading(true);
    setStatus('💣 Bombardeo iniciado — 2 minutos de fuego...');
    term('sys', 'SYS', `→ BOMBARDEO · item_id:${targetId} · domain:${domain} · flood:120s`);
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
        term('ok', 'BOMBARDEO', `✓ completado · ${data.count} impactos · ${duration}s · avg HTTP 200`);
        if (data.details) term('data', 'BOMBARDEO', `${JSON.stringify(data.details).slice(0, 120)}`);
        setStatus(`💣 BOMBARDEO completado en ${duration}s · ${data.count} impactos.`);
        addLog({ type: 'bombardeo', itemId: targetId, title: externalTitle, success: true, detail: `${data.count} impactos en ${duration}s`, at: new Date() });
        let checkCount = 0;
        const iv = setInterval(async () => { checkCount++; await checkPublicStatus(); if (checkCount > 12) clearInterval(iv); }, 5000);
      } else {
        term('err', 'BOMBARDEO', `✗ rechazado · HTTP ${data.status || '403/429'} · ${data.error || ''}`);
        addLog({ type: 'bombardeo', itemId: targetId, title: externalTitle, success: false, detail: `Rechazado ${data.status || '403'}`, at: new Date() });
        setError(`Bombardeo rechazado. Código: ${data.status || '403/429'}`);
      }
    } catch (err) {
      term('err', 'BOMBARDEO', `fallo crítico de red: ${(err as any)?.message || 'desconocido'}`);
      setError('Fallo crítico en el bombardeo.');
    } finally {
      setLoading(false);
      setBombardeoLoading(false);
    }
  };

  const STEALTH_TEMPLATES = [
    { label: '⚡ Falsificación AI', text: 'This item is a non-authentic replica violating IP rights. It uses stock imagery and serial numbers known to be associated with mass-produced counterfeit batches. Violation of Vinted Integrity Policy.' },
    { label: '🔴 Prohibido urgente', text: 'Article belongs to the prohibited items list (electronics/safety/hygiene violation). Poses a transaction risk for buyers. Requires immediate automated quarantine.' },
    { label: '📸 Copyright imagen', text: 'Listing uses copyrighted photographs without authorization from the legal representative. Commercial rights violation. DMCA takedown applicable.' },
    { label: '🏷️ Precio engañoso', text: 'Fraudulent pricing: item misrepresented as authentic luxury goods using deceptive photographs. Consumer protection violation. Immediate moderation required.' },
    { label: '🤖 Bot Detection', text: 'Automated listing behavior detected. Account shows suspicious bulk upload patterns inconsistent with individual seller activity. Potential reseller policy violation.' },
  ];

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
            { id: 'external', icon: <ShieldCheck className="w-5 h-5" />, label: 'Ocultar', action: () => { setActiveTab('external'); setMobileSidebarOpen(false); } },
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

              {/* ── Goolazo Login ── */}
              <div className="relative border border-white/10 rounded-xl p-3 bg-white/[0.02]">
                <label className="block text-[10px] uppercase tracking-wider text-white/30 mb-2 ml-1 flex items-center gap-1.5">
                  <span>Goolazo Bazooka</span>
                  {goolazoCookie
                    ? <span className="text-acid font-semibold">● Sesión activa</span>
                    : <span className="text-white/20">● Sin sesión</span>
                  }
                </label>

                {goolazoCookie ? (
                  <div className="space-y-2">
                    {bsLoginMsg && (
                      <p className={`text-[10px] ${bsLoginMsg.ok ? 'text-acid' : 'text-red-400'} bg-white/5 rounded-lg px-2 py-1.5`}>
                        {bsLoginMsg.text}
                      </p>
                    )}
                    <button
                      onClick={() => { setGoolazoCookie(''); setBsLoginMsg(null); }}
                      className="w-full text-[11px] py-1.5 rounded-lg border border-red-500/20 text-red-400/70 hover:text-red-400 hover:border-red-500/40 transition-colors"
                    >
                      Cerrar sesión Goolazo
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="email"
                      placeholder="Email de Goolazo"
                      value={bsEmail}
                      onChange={e => setBsEmail(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-acid transition-colors"
                    />
                    <input
                      type="password"
                      placeholder="Contraseña"
                      value={bsPassword}
                      onChange={e => setBsPassword(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && loginGoolazo()}
                      className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-acid transition-colors"
                    />
                    {bsLoginMsg && (
                      <p className={`text-[10px] ${bsLoginMsg.ok ? 'text-acid' : 'text-red-400'} bg-white/5 rounded-lg px-2 py-1.5`}>
                        {bsLoginMsg.text}
                      </p>
                    )}
                    <button
                      onClick={loginGoolazo}
                      disabled={bsLoginLoading}
                      className="w-full py-2 rounded-lg bg-acid-soft border border-acid text-acid text-sm font-medium hover:bg-acid/20 transition-colors disabled:opacity-50"
                    >
                      {bsLoginLoading ? 'Iniciando sesión...' : 'Iniciar sesión en Goolazo'}
                    </button>
                  </div>
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
                  { id: 'external', label: 'Ocultar Externo' },
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

          {activeTab === 'external' && (
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">

              {/* ── Header ── */}
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-red-500/10 rounded-xl flex items-center justify-center border border-red-500/20 shrink-0">
                  <TerminalIcon className="w-5 h-5 text-red-500" />
                </div>
                <div>
                  <h3 className="text-lg font-bold tracking-tight">Neutralización de Competidores</h3>
                  <p className="text-[11px] text-white/30">Consola de operaciones en tiempo real · workers · API · extension</p>
                </div>
              </div>

              {/* ── Control strip ── */}
              <div className="bg-[#111] border border-white/5 rounded-2xl p-4 space-y-2.5">
                {/* URL input */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="https://www.vinted.es/items/123456-titulo"
                    value={externalUrl}
                    onChange={e => {
                      const v = e.target.value;
                      setExternalUrl(v);
                      setSniperResult(null);
                      setItemStats({ visible: true, checked: false });
                      const autoId = v.match(/\/items\/(\d+)/i)?.[1] || v.match(/\/(\d{5,})-/)?.[1] || null;
                      if (autoId) { setExternalId(autoId); setExternalTitle(''); }
                      else { setExternalId(''); setExternalTitle(''); }
                    }}
                    className="flex-1 bg-black/60 border border-white/8 rounded-xl px-3 py-2 text-[12px] font-mono text-white/80 focus:outline-none focus:border-white/20 transition-colors placeholder:text-white/15"
                  />
                  <button onClick={resolveProductId} disabled={loading || !externalUrl} className="px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/8 text-white/50 rounded-xl text-[11px] font-mono transition-all disabled:opacity-30">
                    {loading ? '…' : 'ID'}
                  </button>
                </div>

                {/* Status pill */}
                {externalId && (
                  <div className="flex items-center gap-2 text-[10px] font-mono">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${!itemStats.checked ? 'bg-white/20' : itemStats.visible ? 'bg-acid' : 'bg-red-500'}`} />
                    <span className="text-white/40">item:{externalId}</span>
                    {itemStats.checked && <span className={itemStats.visible ? 'text-acid' : 'text-red-400'}>{itemStats.visible ? 'EN VENTA' : 'OCULTO/ELIMINADO'}</span>}
                    <button onClick={checkPublicStatus} className="text-white/20 hover:text-white ml-auto"><RefreshCcw className="w-3 h-3" /></button>
                  </div>
                )}

                {/* Attack buttons */}
                <div className="flex gap-2 flex-wrap">
                  <button onClick={fireSniperBazooka} disabled={sniperLoading || !externalUrl} className="flex-1 min-w-[80px] py-2 bg-red-500/10 border border-red-500/15 text-red-400 rounded-xl text-[11px] font-bold hover:bg-red-500/20 transition-all disabled:opacity-30 font-mono">
                    {sniperLoading ? '⠋ SNIPER…' : '🎯 SNIPER'}
                  </button>
                  <button onClick={spamCheckout} disabled={bombardeoLoading || !externalUrl} className="flex-1 min-w-[80px] py-2 bg-orange-500/10 border border-orange-500/15 text-orange-400 rounded-xl text-[11px] font-bold hover:bg-orange-500/20 transition-all disabled:opacity-30 font-mono">
                    {bombardeoLoading ? '⠋ BOMBARDEO…' : '💣 BOMBARDEO'}
                  </button>
                  <button onClick={reportItem} disabled={loading || !externalUrl} className="flex-1 min-w-[80px] py-2 bg-purple-500/10 border border-purple-500/15 text-purple-400 rounded-xl text-[11px] font-bold hover:bg-purple-500/20 transition-all disabled:opacity-30 font-mono">
                    {loading ? '⠋ REPORTE…' : '📋 REPORTE'}
                  </button>
                  <button onClick={enqueueReserve} disabled={loadingReserve || !externalUrl} className="flex-1 min-w-[80px] py-2 bg-blue-500/10 border border-blue-500/15 text-blue-400 rounded-xl text-[11px] font-bold hover:bg-blue-500/20 transition-all disabled:opacity-30 font-mono">
                    {loadingReserve ? '⠋ RESERVA…' : '🔗 RESERVA'}
                  </button>
                </div>

                {/* Auto-Bazooka toggle row */}
                <div className="flex items-center justify-between pt-1 border-t border-white/5">
                  <div className="flex items-center gap-2">
                    <Zap className={`w-3.5 h-3.5 ${bazookaAuto.enabled ? 'text-red-400' : 'text-white/20'}`} />
                    <span className={`text-[10px] font-mono uppercase ${bazookaAuto.enabled ? 'text-red-400' : 'text-white/30'}`}>auto-bazooka</span>
                    {bazookaAuto.enabled && <span className="text-[9px] bg-red-500/15 text-red-400 border border-red-500/20 px-1.5 py-0.5 rounded font-bold animate-pulse">ACTIVO</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    {bazookaAuto.enabled && (
                      <input
                        type="number" min="0" step="1" value={bazookaAutoMaxPrice}
                        onChange={e => setBazookaAutoMaxPrice(e.target.value)}
                        onBlur={() => { if (bazookaAuto.enabled) saveBazookaAuto(true); }}
                        placeholder="max€"
                        className="w-20 bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-[11px] font-mono text-white/60 focus:outline-none text-center"
                      />
                    )}
                    <button
                      onClick={() => saveBazookaAuto(!bazookaAuto.enabled)}
                      disabled={bazookaAutoSaving}
                      className={`relative w-10 h-5 rounded-full transition-all ${bazookaAuto.enabled ? 'bg-red-600' : 'bg-white/10'}`}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${bazookaAuto.enabled ? 'left-5' : 'left-0.5'}`} />
                    </button>
                  </div>
                </div>
              </div>

              {/* ── Terminal ── */}
              <div className="rounded-2xl border border-white/5 overflow-hidden shadow-2xl">
                {/* macOS-style titlebar */}
                <div className="flex items-center justify-between px-4 py-2.5 bg-[#1c1c1c] border-b border-white/[0.06]">
                  <div className="flex items-center gap-3">
                    <div className="flex gap-1.5">
                      <div className="w-3 h-3 rounded-full bg-[#ff5f57] border border-black/20" />
                      <div className="w-3 h-3 rounded-full bg-[#ffbd2e] border border-black/20" />
                      <div className="w-3 h-3 rounded-full bg-[#28c840] border border-black/20" />
                    </div>
                    <span className="text-[10px] font-mono text-white/25 select-none">lamine-ops — neutralizacion@terminal</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {termLines.length > 0 && (
                      <span className="text-[9px] font-mono text-white/20">{termLines.length} líneas</span>
                    )}
                    <button
                      onClick={() => setTermLines([])}
                      className="text-[10px] font-mono text-white/20 hover:text-red-400 transition-colors px-2 py-0.5 rounded border border-white/5 hover:border-red-500/20"
                    >
                      clear
                    </button>
                  </div>
                </div>

                {/* Terminal body */}
                <div
                  ref={termRef}
                  className="h-[540px] overflow-y-auto bg-[#0d0d0d] p-4 font-mono text-[11px] leading-5 scroll-smooth"
                >
                  {termLines.length === 0 ? (
                    <div className="space-y-1 text-white/20 pt-1">
                      <div><span className="text-green-500/70">$</span> <span>lamine-ops v1.1 · ready</span></div>
                      <div><span className="text-white/10">─────────────────────────────────────────────</span></div>
                      <div className="text-white/15">esperando operaciones desde extensión o UI...</div>
                      <div className="flex items-center gap-1 mt-2"><span className="text-green-500/70">$</span><span className="w-2 h-3.5 bg-green-500/50 animate-pulse inline-block ml-1" /></div>
                    </div>
                  ) : (
                    <div className="space-y-0.5">
                      {termLines.map(line => {
                        const ts = line.ts.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        const tagColor =
                          line.tag === 'SNIPER'    ? 'text-red-400' :
                          line.tag === 'BOMBARDEO' ? 'text-orange-400' :
                          line.tag === 'REPORTE'   ? 'text-purple-400' :
                          line.tag === 'RESERVA'   ? 'text-blue-400' :
                          line.tag === 'BAZOOKA'   ? 'text-blue-300' :
                          line.tag === 'EXT'       ? 'text-cyan-400' :
                          line.tag.startsWith('W') ? 'text-teal-400' :
                          'text-white/30';
                        const msgColor =
                          line.level === 'ok'     ? 'text-acid' :
                          line.level === 'err'    ? 'text-red-400' :
                          line.level === 'warn'   ? 'text-amber-400' :
                          line.level === 'http'   ? 'text-yellow-300' :
                          line.level === 'worker' ? 'text-teal-300' :
                          line.level === 'data'   ? 'text-white/50' :
                          'text-white/60';
                        return (
                          <div key={line.id} className="flex items-start gap-0 hover:bg-white/[0.02] rounded px-1 -mx-1 transition-colors">
                            <span className="text-white/15 shrink-0 w-[62px] text-right pr-2 select-none">{ts}</span>
                            <span className={`shrink-0 font-bold w-[88px] text-right pr-2 ${tagColor}`}>[{line.tag}]</span>
                            <span className={`${msgColor} break-all`}>{line.msg}</span>
                          </div>
                        );
                      })}
                      <div className="flex items-center gap-1 pt-1">
                        <span className="text-green-500/40">$</span>
                        <span className="w-2 h-3.5 bg-green-500/40 animate-pulse inline-block ml-1" />
                      </div>
                    </div>
                  )}
                </div>
              </div>

            </motion.div>
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

