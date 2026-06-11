import React, { useState, useEffect, Suspense, lazy } from 'react';
import { Key, AlertCircle, CheckCircle2, Lock, GraduationCap } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

import AuthPage from './components/AuthPage';
import AdminPanel from './components/AdminPanel';
import Sidebar, { MobileTabBar, type Page } from './components/Sidebar';

// ─── Permisos ─────────────────────────────────────────────────────────────────
// 'photos' = Fantasma — siempre disponible para todos
// 'academia' = desbloquea todo lo demás

const ALL_PAGES: Page[] = ['dashboard', 'accounts', 'inventory', 'orders', 'profits', 'tongue', 'photos', 'alfombras', 'metadatos', 'settings', 'publish'];

function computeAllowedPages(license: any, isAdmin: boolean): Set<Page> {
  if (isAdmin) return new Set(ALL_PAGES);
  const features: string[] = license?.features || ['photos'];
  const pages = new Set<Page>(['photos', 'alfombras', 'metadatos', 'settings']); // mínimo gratuito
  if (features.includes('all') || features.includes('academia')) {
    ALL_PAGES.forEach(p => pages.add(p));
  }
  return pages;
}

// ─── Pantalla de acceso bloqueado ─────────────────────────────────────────────
function LockedPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[65vh] gap-6 text-center px-4">
      <div className="w-16 h-16 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
        <Lock className="w-7 h-7 text-white/20" />
      </div>
      <div>
        <h2 className="text-xl font-bold text-[#f2f2ef]">Acceso restringido</h2>
        <p className="text-[#888880] mt-2 max-w-xs leading-relaxed">
          Necesitas estar en la <span className="text-[#d4ff00] font-semibold">academia de Lamine</span> para acceder a esta sección.
        </p>
      </div>
      <a
        href="https://www.skool.com/lamineresell/plans"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 bg-[#d4ff00] hover:bg-[#b3da00] text-black font-bold px-6 py-3 rounded-xl transition shadow-[0_12px_32px_-8px_rgba(212,255,0,0.35)]"
      >
        <GraduationCap className="w-4 h-4" />
        Unirse a la academia
      </a>
    </div>
  );
}

import SettingsPage from './components/pages/SettingsPage';

// ── Lazy chunks por feature ────────────────────────────────────────────────────
// academia — se descargan SOLO cuando el usuario tiene esta feature activa
const DashboardPage    = lazy(() => import('./components/pages/DashboardPage'));
const AccountsPage     = lazy(() => import('./components/pages/AccountsPage'));
const InventoryPage    = lazy(() => import('./components/pages/InventoryPage'));
const OrdersPage       = lazy(() => import('./components/pages/OrdersPage'));
const ProfitControl    = lazy(() => import('./components/ProfitControl'));
const TongueEditor     = lazy(() => import('./components/TongueEditor'));
const CarpetEditor     = lazy(() => import('./components/CarpetEditor'));
const MetadatosEditor  = lazy(() => import('./components/MetadatosEditor'));
const VintedAutoPublish = lazy(() => import('./components/VintedAutoPublish'));
// photos
const ImageUniquifier  = lazy(() => import('./components/ImageUniquifier'));

function ChunkLoading() {
  return (
    <div className="flex items-center justify-center min-h-[65vh]">
      <div className="w-5 h-5 rounded-full border-2 border-white/10 border-t-[#d4ff00]/60 animate-spin" />
    </div>
  );
}
const S = ({ children }: { children: React.ReactNode }) => (
  <Suspense fallback={<ChunkLoading />}>{children}</Suspense>
);

// ─── License activation ───────────────────────────────────────────────────────

function LicenseActivation({ token, onActivated }: { token: string; onActivated: () => void }) {
  const [key, setKey]       = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);
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
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-[20px] bg-[#d4ff00]/10 border border-[#d4ff00]/25 mb-4">
            <Key className="w-8 h-8 text-[#d4ff00]" />
          </div>
          <h1 className="text-2xl font-bold text-[#f2f2ef]">Activar licencia</h1>
          <p className="text-[#888880] text-sm mt-1">Introduce tu clave para acceder</p>
        </div>
        <div className="bg-[#161616] border border-white/[0.08] rounded-[28px] p-6">
          {success ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <CheckCircle2 className="w-12 h-12 text-[#d4ff00]" />
              <p className="text-[#f2f2ef] font-medium">¡Licencia activada!</p>
            </div>
          ) : (
            <form onSubmit={activate} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-[#888880] mb-1.5">Clave de licencia</label>
                <input
                  type="text"
                  value={key}
                  onChange={e => setKey(e.target.value.toUpperCase())}
                  placeholder="FC-XXXX-XXXX-XXXX-XXXX"
                  required
                  className="w-full bg-[#1c1c1c] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm font-mono text-[#f2f2ef] placeholder-[#555550] focus:outline-none focus:border-[#d4ff00]/40 transition"
                />
              </div>
              {error && (
                <div className="flex items-center gap-2 bg-[#ff8080]/10 border border-[#ff8080]/20 rounded-xl px-3 py-2.5 text-sm text-[#ff8080]">
                  <AlertCircle className="w-4 h-4 shrink-0" />{error}
                </div>
              )}
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-[#d4ff00] hover:bg-[#b3da00] disabled:opacity-50 text-black font-semibold rounded-xl py-2.5 text-sm transition shadow-[0_18px_40px_-12px_rgba(212,255,0,0.38)]"
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

// ─── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem('fc_token'));
  const [authUser, setAuthUser]   = useState<any>(null);
  const [license, setLicense]     = useState<any>(null);
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
      .then(data => {
        if (data.user) setAuthUser(data.user); // actualiza rank y otros campos frescos del servidor
        setLicense(data.license);
      })
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
        <div className="w-8 h-8 border-2 border-[#d4ff00] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!authToken || !authUser) return <AuthPage onAuth={handleAuth} />;

  if (!license && !authUser.is_admin) {
    return (
      <LicenseActivation token={authToken} onActivated={() => {
        fetch('/api/auth/me', { headers: { Authorization: `Bearer ${authToken}` } })
          .then(r => r.json()).then(data => setLicense(data.license));
      }} />
    );
  }

  if (authUser.is_admin && showAdmin) {
    return <AdminPanel token={authToken} onLogout={handleLogout} onBack={() => setShowAdmin(false)} />;
  }

  return (
    <Dashboard
      token={authToken}
      user={authUser}
      license={license}
      onLogout={handleLogout}
      onAdmin={authUser.is_admin ? () => setShowAdmin(true) : undefined}
    />
  );
}

// ─── Dashboard shell ──────────────────────────────────────────────────────────

function Dashboard({
  token,
  user,
  license,
  onLogout,
  onAdmin,
}: {
  token: string;
  user: any;
  license: any;
  onLogout: () => void;
  onAdmin?: () => void;
}) {
  const allowedPages = computeAllowedPages(license, !!user?.is_admin);
  // Página inicial: si tiene acceso a dashboard → dashboard, si no → photos (Fantasma)
  const [page, setPage] = useState<Page>(() => allowedPages.has('dashboard') ? 'dashboard' : 'photos');

  // Share token with Chrome extension so it doesn't need a separate login
  useEffect(() => {
    if (!token) return;
    window.dispatchEvent(new CustomEvent('founderclub-token', { detail: { token } }));
  }, [token]);

  const renderPage = () => {
    // Gate: si la página no está permitida, mostrar pantalla de bloqueo
    if (!allowedPages.has(page)) return <LockedPage />;

    switch (page) {
      case 'dashboard':  return <S><DashboardPage   token={token} /></S>;
      case 'accounts':   return <S><AccountsPage    token={token} /></S>;
      case 'inventory':  return <S><InventoryPage   token={token} /></S>;
      case 'orders':     return <S><OrdersPage      token={token} /></S>;
      case 'profits':    return <S><ProfitControl   token={token} /></S>;
      case 'publish':    return <S><VintedAutoPublish token={token} /></S>;
      case 'tongue':     return <S><TongueEditor /></S>;
      case 'photos':     return <S><ImageUniquifier /></S>;
      case 'alfombras':  return <S><CarpetEditor token={token} isPro={user?.rank === 'pro'} isAdmin={!!user?.is_admin} /></S>;
      case 'metadatos':  return <S><MetadatosEditor /></S>;
      case 'settings':   return <SettingsPage token={token} user={user} license={license} onLogout={onLogout} />;
    }
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        currentPage={page}
        onNavigate={setPage}
        user={user}
        allowedPages={allowedPages}
        onLogout={onLogout}
        onAdmin={onAdmin}
      />

      <main className="flex-1 overflow-y-auto">
        <div className="p-4 lg:p-8 pb-28 lg:pb-8 max-w-[1280px] mx-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={page}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            >
              {renderPage()}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      <MobileTabBar currentPage={page} onNavigate={setPage} allowedPages={allowedPages} />
    </div>
  );
}
