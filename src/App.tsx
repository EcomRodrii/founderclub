import React, { useState, useEffect } from 'react';
import { Key, AlertCircle, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

import AuthPage from './components/AuthPage';
import AdminPanel from './components/AdminPanel';
import Sidebar, { MobileTabBar, type Page } from './components/Sidebar';

import DashboardPage  from './components/pages/DashboardPage';
import AccountsPage   from './components/pages/AccountsPage';
import InventoryPage  from './components/pages/InventoryPage';
import OrdersPage     from './components/pages/OrdersPage';
import BoostPage      from './components/pages/BoostPage';
import SettingsPage   from './components/pages/SettingsPage';

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
  const [page, setPage] = useState<Page>('dashboard');

  // Share token with Chrome extension so it doesn't need a separate login
  useEffect(() => {
    if (!token) return;
    window.dispatchEvent(new CustomEvent('founderclub-token', { detail: { token } }));
  }, [token]);

  const renderPage = () => {
    switch (page) {
      case 'dashboard':  return <DashboardPage  token={token} />;
      case 'accounts':   return <AccountsPage   token={token} />;
      case 'inventory':  return <InventoryPage  token={token} />;
      case 'orders':     return <OrdersPage     token={token} />;
      case 'boost':      return <BoostPage      token={token} />;
      case 'settings':   return (
        <SettingsPage
          token={token}
          user={user}
          license={license}
          onLogout={onLogout}
        />
      );
    }
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        currentPage={page}
        onNavigate={setPage}
        user={user}
        onLogout={onLogout}
        onAdmin={onAdmin}
      />

      <main className="flex-1 overflow-y-auto">
        <div className="p-6 lg:p-8 pb-24 lg:pb-8 max-w-[1200px]">
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

      <MobileTabBar currentPage={page} onNavigate={setPage} />
    </div>
  );
}
