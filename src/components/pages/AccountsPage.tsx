import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, Trash2, AlertCircle, X, Globe } from 'lucide-react';

interface Account {
  id: number;
  login: string;
  title: string;
  status: string;
  country_code: string;
  items_count: number;
  sold_count: number;
  last_synced_at: string | null;
}

interface AccountsPageProps {
  token: string;
}

const COUNTRY_FLAGS: Record<string, string> = {
  es: '🇪🇸', fr: '🇫🇷', it: '🇮🇹', nl: '🇳🇱',
  de: '🇩🇪', pl: '🇵🇱', uk: '🇬🇧', com: '🌍',
};

function StatusBadge({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-[#d4ff00]/10 text-[#d4ff00] border border-[#d4ff00]/20">
        <span className="w-1.5 h-1.5 rounded-full bg-[#d4ff00]" />
        Activa
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-white/5 text-white/40 border border-white/10">
      <span className="w-1.5 h-1.5 rounded-full bg-white/30" />
      Inactiva
    </span>
  );
}

function AddAccountModal({ token, onClose, onAdded }: { token: string; onClose: () => void; onAdded: () => void }) {
  const [cookie, setCookie] = useState('');
  const [domain, setDomain] = useState('es');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/vinted/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ cookie: cookie.trim(), domain }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al añadir cuenta');
      onAdded();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 16 }}
        className="bg-[#161616] border border-white/[0.1] rounded-2xl p-6 w-full max-w-md shadow-2xl"
      >
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-[1rem] font-semibold text-[#f2f2ef]">Añadir cuenta Vinted</h2>
            <p className="text-[0.75rem] text-[#888880] mt-0.5">Conecta una cuenta con tu cookie de sesión</p>
          </div>
          <button onClick={onClose} className="text-[#888880] hover:text-[#f2f2ef] transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-[0.75rem] font-medium uppercase tracking-widest text-[#888880] mb-1.5">
              Dominio
            </label>
            <select
              value={domain}
              onChange={e => setDomain(e.target.value)}
              className="w-full bg-[#1c1c1c] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-[#f2f2ef] focus:outline-none focus:border-[#d4ff00]/40 transition-colors appearance-none"
            >
              {['es', 'fr', 'it', 'nl', 'de', 'pl', 'uk', 'com'].map(d => (
                <option key={d} value={d}>vinted.{d}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[0.75rem] font-medium uppercase tracking-widest text-[#888880] mb-1.5">
              Cookie de sesión
            </label>
            <textarea
              value={cookie}
              onChange={e => setCookie(e.target.value)}
              placeholder="_vinted_es_session=..."
              required
              rows={4}
              className="w-full bg-[#1c1c1c] border border-white/[0.08] rounded-xl px-4 py-3 text-sm font-mono text-[#f2f2ef] placeholder-[#555550] focus:outline-none focus:border-[#d4ff00]/40 transition-colors resize-none"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 bg-[#ff8080]/10 border border-[#ff8080]/20 rounded-xl px-3 py-2.5 text-sm text-[#ff8080]">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-white/[0.08] text-[0.85rem] font-medium text-[#888880] hover:text-[#f2f2ef] hover:border-white/[0.16] transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2.5 rounded-xl bg-[#d4ff00] text-black text-[0.85rem] font-semibold hover:bg-[#b3da00] disabled:opacity-50 transition-colors"
            >
              {loading ? 'Añadiendo…' : 'Añadir cuenta'}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}

export default function AccountsPage({ token }: AccountsPageProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/vinted/accounts', { headers: authHeaders });
      const data = await res.json();
      setAccounts(data.ok ? data.data.accounts : []);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, [token]);

  const deleteAccount = async (id: number) => {
    setDeletingId(id);
    try {
      await fetch(`/api/vinted/accounts/${id}`, { method: 'DELETE', headers: authHeaders });
      setAccounts(prev => prev.filter(a => a.id !== id));
    } catch {}
    setDeletingId(null);
  };

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <p className="font-display text-[0.75rem] tracking-[0.3em] text-[#d4ff00]">GESTIÓN</p>
          <h1 className="font-display text-[2.4rem] leading-none tracking-[0.02em] text-[#f2f2ef] mt-1">Cuentas</h1>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[#d4ff00] text-black text-[0.85rem] font-semibold rounded-xl hover:bg-[#b3da00] transition-colors shadow-[0_0_24px_rgba(212,255,0,0.18)]"
        >
          <Plus className="w-4 h-4" />
          Añadir cuenta
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="w-6 h-6 border-2 border-[#d4ff00] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : accounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 border border-dashed border-white/[0.08] rounded-2xl text-center px-8">
          <div className="w-14 h-14 rounded-full bg-white/[0.03] flex items-center justify-center mb-4">
            <Globe className="w-7 h-7 text-white/15" />
          </div>
          <p className="text-[0.95rem] font-medium text-[#888880]">Sin cuentas vinculadas</p>
          <p className="text-[0.8rem] text-[#555550] mt-1 max-w-xs">
            Añade tu primera cuenta de Vinted con la cookie de sesión para empezar a gestionar tu inventario.
          </p>
          <button
            onClick={() => setShowModal(true)}
            className="mt-5 flex items-center gap-2 px-4 py-2.5 bg-[#d4ff00] text-black text-[0.85rem] font-semibold rounded-xl hover:bg-[#b3da00] transition-colors"
          >
            <Plus className="w-4 h-4" />
            Añadir primera cuenta
          </button>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <AnimatePresence>
            {accounts.map((acc) => (
              <motion.div
                key={acc.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-[#161616] border border-white/[0.06] rounded-2xl p-5 hover:border-white/[0.12] transition-colors group"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-[#d4ff00]/10 border border-[#d4ff00]/20 flex items-center justify-center shrink-0">
                      <span className="text-[12px] font-bold text-[#d4ff00]">
                        {acc.login.slice(0, 2).toUpperCase()}
                      </span>
                    </div>
                    <div>
                      <p className="text-[0.9rem] font-semibold text-[#f2f2ef] leading-tight">{acc.login}</p>
                      <p className="text-[0.72rem] text-[#888880]">
                        {COUNTRY_FLAGS[acc.country_code] || '🌍'} vinted.{acc.country_code}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => deleteAccount(acc.id)}
                    disabled={deletingId === acc.id}
                    className="opacity-0 group-hover:opacity-100 text-[#555550] hover:text-[#ff8080] transition-all disabled:opacity-50"
                    title="Eliminar cuenta"
                  >
                    {deletingId === acc.id
                      ? <div className="w-4 h-4 border border-[#ff8080] border-t-transparent rounded-full animate-spin" />
                      : <Trash2 className="w-4 h-4" />
                    }
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="bg-[#1c1c1c] rounded-xl p-3 text-center">
                    <p className="font-display text-[1.4rem] leading-none text-[#f2f2ef]">{acc.items_count}</p>
                    <p className="text-[0.7rem] text-[#888880] mt-1">Activos</p>
                  </div>
                  <div className="bg-[#1c1c1c] rounded-xl p-3 text-center">
                    <p className="font-display text-[1.4rem] leading-none text-[#f2f2ef]">{acc.sold_count}</p>
                    <p className="text-[0.7rem] text-[#888880] mt-1">Vendidos</p>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <StatusBadge status={acc.status} />
                  {acc.last_synced_at && (
                    <span className="text-[0.7rem] text-[#555550]">
                      Sync {new Date(acc.last_synced_at).toLocaleDateString('es-ES')}
                    </span>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <AnimatePresence>
        {showModal && (
          <AddAccountModal token={token} onClose={() => setShowModal(false)} onAdded={load} />
        )}
      </AnimatePresence>
    </div>
  );
}
