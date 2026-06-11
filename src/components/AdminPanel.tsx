import React, { useState, useEffect, useCallback, useRef } from 'react';
import { E } from '../lib/ep';
import { motion } from 'motion/react';
import {
  Users, Key, Activity, LogOut, Plus, Trash2,
  RefreshCcw, Shield, ShieldOff, Copy, Check,
  ToggleLeft, ToggleRight, Fingerprint, Globe, Clock,
  FileText, Save, Package, ImagePlus, Hash,
  Search, Ban, Unlock, KeyRound, BarChart3,
  Database, Cpu, Zap, AlertTriangle, TrendingUp, Crown, X
} from 'lucide-react';

interface AdminPanelProps {
  token: string;
  onLogout: () => void;
  onBack?: () => void;
}

type Tab = 'stats' | 'users' | 'activity' | 'licenses' | 'sessions' | 'prompts' | 'references' | 'monitor';

const BRANDS = ['ADIDAS', 'NEW BALANCE', 'ASICS', 'ONITSUKA'] as const;
type Brand = typeof BRANDS[number];

const api = (token: string) => ({
  get: (url: string) => fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
  post: (url: string, body: any) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(r => r.json()),
  patch: (url: string, body?: any) =>
    fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json()),
  delete: (url: string) =>
    fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
});

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="ml-1 text-zinc-500 hover:text-zinc-300 transition"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function Badge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    lifetime: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    monthly: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
    trial: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    custom: 'bg-acid-soft text-acid border-acid',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${colors[type] || 'bg-zinc-700 text-zinc-400 border-zinc-600'}`}>
      {type}
    </span>
  );
}

function formatDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function truncate(s: string | null, len = 18) {
  if (!s) return '—';
  return s.length > len ? s.slice(0, len) + '…' : s;
}

// ─── Helpers de fecha ─────────────────────────────────────────────────────────

function timeAgo(d: string | null): string {
  if (!d) return '—';
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'ahora mismo';
  if (s < 3600) return `hace ${Math.floor(s/60)}m`;
  if (s < 86400) return `hace ${Math.floor(s/3600)}h`;
  if (s < 86400*7) return `hace ${Math.floor(s/86400)}d`;
  return formatDate(d);
}
function isOnline(d: string | null): boolean {
  if (!d) return false;
  return (Date.now() - new Date(d).getTime()) < 10 * 60 * 1000;
}

// ─── ActionRow ────────────────────────────────────────────────────────────────

function ActionRow({ label, value, valueColor, btnLabel, btnColor, loading, onClick }: {
  label: string; value: string; valueColor: string;
  btnLabel: string; btnColor: string; loading: boolean; onClick: () => void;
}) {
  return (
    <div className="bg-zinc-900 rounded-xl px-3 py-2.5 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-zinc-500 shrink-0">{label}</span>
        <span className={`text-xs font-semibold ${valueColor} truncate`}>{value}</span>
      </div>
      <button
        onClick={onClick}
        disabled={loading}
        className={`text-[11px] font-medium px-2.5 py-1 rounded-lg transition shrink-0 ${btnColor} disabled:opacity-40`}
      >
        {loading ? '…' : btnLabel}
      </button>
    </div>
  );
}

// ─── UserDrawer ───────────────────────────────────────────────────────────────

function UserDrawer({ user, token, onClose, onRefresh }: {
  user: any; token: string; onClose: () => void; onRefresh: () => void;
}) {
  const client = api(token);
  const [busy, setBusy] = useState<string | null>(null);
  const [pwdMode, setPwdMode] = useState(false);
  const [pwd, setPwd] = useState('');
  const [pwdDone, setPwdDone] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [creditAmt, setCreditAmt] = useState('50');

  const act = async (key: string, fn: () => Promise<any>) => {
    setBusy(key);
    try { await fn(); onRefresh(); }
    catch (e) { console.error(e); }
    finally { setBusy(null); }
  };

  const resetPwd = async () => {
    if (pwd.length < 6) return;
    setBusy('pwd');
    try {
      await client.post(`/api/admin/users/${user.id}/reset-password`, { password: pwd });
      setPwdDone(true);
      setTimeout(() => { setPwdMode(false); setPwd(''); setPwdDone(false); }, 2000);
    } finally { setBusy(null); }
  };

  const online = isOnline(user.last_seen_at);
  const initials = (user.username || 'U').slice(0, 2).toUpperCase();

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-sm bg-zinc-950 border-l border-zinc-800 flex flex-col shadow-2xl overflow-y-auto">

        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`relative w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold text-white bg-zinc-800 border-2 shrink-0 ${online ? 'border-green-400' : 'border-zinc-700'}`}>
              {initials}
              {online && <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-green-400 border-2 border-zinc-950" />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-semibold text-white truncate">{user.username}</span>
                {user.is_admin && <span className="text-[10px] bg-violet-500/15 text-violet-400 border border-violet-500/30 rounded px-1.5 py-0.5 shrink-0">admin</span>}
                {user.rank === 'pro' && <span className="text-[10px] bg-yellow-500/15 text-yellow-400 border border-yellow-500/30 rounded px-1.5 py-0.5 inline-flex items-center gap-0.5 shrink-0"><Crown className="w-2.5 h-2.5" /> Pro</span>}
                {user.is_blocked && <span className="text-[10px] bg-red-500/15 text-red-400 border border-red-500/30 rounded px-1.5 py-0.5 shrink-0">bloqueado</span>}
              </div>
              <p className="text-xs text-zinc-500 mt-0.5 truncate">{user.email}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition shrink-0 ml-2 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2 p-4 border-b border-zinc-800 shrink-0">
          {[
            { label: 'Último login', value: timeAgo(user.last_login_at) },
            { label: 'Visto',        value: timeAgo(user.last_seen_at) },
            { label: 'Uso hoy',      value: `${user.daily_usage_today ?? 0}/10` },
          ].map(s => (
            <div key={s.label} className="bg-zinc-900 rounded-xl px-2 py-2.5 text-center">
              <p className="text-[10px] text-zinc-600 mb-0.5">{s.label}</p>
              <p className="text-xs font-semibold text-white leading-tight">{s.value}</p>
            </div>
          ))}
        </div>

        {/* IP */}
        <div className="px-4 py-2.5 border-b border-zinc-800 shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5 text-zinc-600" />
            <span className="text-xs font-mono text-zinc-400">{user.last_ip || '(sin IP)'}</span>
          </div>
          {user.last_ip && (
            <button
              onClick={() => act('clearip', () => client.patch(`/api/admin/users/${user.id}/clear-ip`))}
              disabled={busy === 'clearip'}
              className="text-[11px] text-zinc-600 hover:text-red-400 transition"
            >
              {busy === 'clearip' ? '…' : 'borrar'}
            </button>
          )}
        </div>

        {/* Generaciones hoy */}
        <div className="px-4 py-3 border-b border-zinc-800 shrink-0 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <RefreshCcw className="w-3.5 h-3.5 text-zinc-600" />
              <span className="text-xs text-zinc-400">
                Generaciones hoy: <span className={`font-semibold ${(user.daily_usage_today ?? 0) >= 10 ? 'text-red-400' : 'text-zinc-300'}`}>{user.daily_usage_today ?? 0}/10</span>
              </span>
            </div>
            {(user.daily_usage_today ?? 0) > 0 && (
              <button
                onClick={() => act('resetdaily', () => client.patch(`/api/admin/users/${user.id}/reset-daily`))}
                disabled={!!busy}
                className="text-[11px] text-zinc-600 hover:text-green-400 transition disabled:opacity-40"
              >
                {busy === 'resetdaily' ? '…' : 'resetear'}
              </button>
            )}
          </div>
          {/* Añadir crédito extra */}
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1} max={9999}
              value={creditAmt}
              onChange={e => setCreditAmt(e.target.value)}
              className="w-16 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1 text-xs text-white text-center focus:outline-none focus:border-[#d4ff00]/50"
            />
            <button
              onClick={() => act('addcredit', () => client.patch(`/api/admin/users/${user.id}/add-daily`, { amount: parseInt(creditAmt, 10) || 50 }))}
              disabled={!!busy}
              className="flex-1 text-[11px] bg-[#d4ff00]/10 hover:bg-[#d4ff00]/20 text-[#d4ff00] border border-[#d4ff00]/20 rounded-lg py-1 transition disabled:opacity-40"
            >
              {busy === 'addcredit' ? '…' : `+ dar ${creditAmt} generaciones`}
            </button>
          </div>
        </div>

        {/* Acciones */}
        <div className="flex-1 p-4 space-y-2">

          <ActionRow
            label="Rango" value={user.rank === 'pro' ? 'Pro' : 'Normal'}
            valueColor={user.rank === 'pro' ? 'text-yellow-400' : 'text-zinc-400'}
            btnLabel={user.rank === 'pro' ? '→ Normal' : '→ Pro'}
            btnColor={user.rank === 'pro'
              ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
              : 'bg-yellow-500/15 hover:bg-yellow-500/25 text-yellow-400 border border-yellow-500/30'}
            loading={busy === 'rank'}
            onClick={() => act('rank', () => client.patch(`/api/admin/users/${user.id}/rank`, { rank: user.rank === 'pro' ? 'normal' : 'pro' }))}
          />

          <ActionRow
            label="Estado" value={user.is_blocked ? 'Bloqueado' : 'Activo'}
            valueColor={user.is_blocked ? 'text-red-400' : 'text-green-400'}
            btnLabel={user.is_blocked ? '→ Desbloquear' : '→ Bloquear'}
            btnColor={user.is_blocked
              ? 'bg-green-500/15 hover:bg-green-500/25 text-green-400 border border-green-500/30'
              : 'bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20'}
            loading={busy === 'block'}
            onClick={() => act('block', () => client.patch(`/api/admin/users/${user.id}/block`, { block: !user.is_blocked }))}
          />

          <ActionRow
            label="Admin" value={user.is_admin ? 'Sí' : 'No'}
            valueColor={user.is_admin ? 'text-violet-400' : 'text-zinc-400'}
            btnLabel={user.is_admin ? '→ Quitar' : '→ Dar admin'}
            btnColor={user.is_admin
              ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
              : 'bg-violet-500/10 hover:bg-violet-500/20 text-violet-400 border border-violet-500/20'}
            loading={busy === 'admin'}
            onClick={() => act('admin', () => client.patch(`/api/admin/users/${user.id}/toggle-admin`))}
          />

          {/* Contraseña */}
          <div className="bg-zinc-900 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500">Contraseña</span>
                <KeyRound className="w-3.5 h-3.5 text-zinc-600" />
              </div>
              <button
                onClick={() => { setPwdMode(m => !m); setPwd(''); setPwdDone(false); }}
                className="text-[11px] text-zinc-500 hover:text-yellow-400 transition"
              >
                {pwdMode ? 'cancelar' : 'cambiar'}
              </button>
            </div>
            {pwdMode && (
              pwdDone ? (
                <div className="flex items-center gap-1.5 text-xs text-green-400"><Check className="w-3.5 h-3.5" /> Contraseña actualizada</div>
              ) : (
                <div className="flex gap-2">
                  <input
                    type="password"
                    placeholder="Nueva contraseña (mín. 6)"
                    value={pwd}
                    onChange={e => setPwd(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') resetPwd(); }}
                    autoFocus
                    className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-yellow-500 min-w-0"
                  />
                  <button
                    onClick={resetPwd}
                    disabled={busy === 'pwd' || pwd.length < 6}
                    className="px-3 py-1.5 bg-yellow-500 hover:bg-yellow-400 disabled:opacity-40 text-black text-xs font-semibold rounded-lg transition shrink-0"
                  >
                    {busy === 'pwd' ? '…' : 'OK'}
                  </button>
                </div>
              )
            )}
          </div>

          {/* Cerrar sesión */}
          <button
            onClick={() => act('logout', () => client.post(`/api/admin/users/${user.id}/force-logout`, {}))}
            disabled={busy === 'logout'}
            className="w-full flex items-center gap-2 px-3 py-2.5 bg-zinc-900 hover:bg-zinc-800 rounded-xl text-xs text-zinc-400 hover:text-white transition"
          >
            <LogOut className="w-3.5 h-3.5 shrink-0" />
            {busy === 'logout' ? 'Cerrando sesión…' : 'Cerrar sesión activa'}
          </button>

          {/* Eliminar cuenta */}
          <div className="pt-2 border-t border-zinc-800/60 mt-2">
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                className="w-full flex items-center gap-2 px-3 py-2.5 bg-red-500/5 hover:bg-red-500/10 border border-red-500/15 hover:border-red-500/30 rounded-xl text-xs text-red-500 hover:text-red-400 transition"
              >
                <Trash2 className="w-3.5 h-3.5 shrink-0" />
                Eliminar cuenta
              </button>
            ) : (
              <div className="bg-red-500/10 border border-red-500/25 rounded-xl p-3 space-y-2">
                <p className="text-xs text-red-400 font-medium">¿Eliminar a <strong>{user.username}</strong>? No se puede deshacer.</p>
                <div className="flex gap-2">
                  <button onClick={() => setConfirmDelete(false)} className="flex-1 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 text-xs rounded-lg transition">
                    Cancelar
                  </button>
                  <button
                    onClick={() => act('delete', async () => { await client.delete(`/api/admin/users/${user.id}`); onClose(); })}
                    disabled={busy === 'delete'}
                    className="flex-1 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition"
                  >
                    {busy === 'delete' ? 'Eliminando…' : 'Sí, eliminar'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ─── AdminPanel ───────────────────────────────────────────────────────────────

export default function AdminPanel({ token, onLogout, onBack }: AdminPanelProps) {
  const [tab, setTab] = useState<Tab>('stats');
  const [stats, setStats] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [licenses, setLicenses] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Generate form
  const [genType, setGenType] = useState('monthly');
  const [genQty, setGenQty] = useState(1);
  const [genDays, setGenDays] = useState(7);
  const [generatedKeys, setGeneratedKeys] = useState<string[]>([]);
  const [genLoading, setGenLoading] = useState(false);

  // Tongue prompts
  const [prompts, setPrompts] = useState<Record<Brand, string>>({
    'ADIDAS': '', 'NEW BALANCE': '', 'ASICS': '', 'ONITSUKA': '',
  });
  const [promptSaving, setPromptSaving] = useState<Record<Brand, boolean>>({
    'ADIDAS': false, 'NEW BALANCE': false, 'ASICS': false, 'ONITSUKA': false,
  });
  const [promptSaved, setPromptSaved] = useState<Record<Brand, boolean>>({
    'ADIDAS': false, 'NEW BALANCE': false, 'ASICS': false, 'ONITSUKA': false,
  });

  // Box prompts (same structure as tongue prompts)
  const [boxPrompts, setBoxPrompts] = useState<Record<Brand, string>>({ 'ADIDAS': '', 'NEW BALANCE': '', 'ASICS': '', 'ONITSUKA': '' });
  const [boxPromptSaving, setBoxPromptSaving] = useState<Record<Brand, boolean>>({ 'ADIDAS': false, 'NEW BALANCE': false, 'ASICS': false, 'ONITSUKA': false });
  const [boxPromptSaved, setBoxPromptSaved] = useState<Record<Brand, boolean>>({ 'ADIDAS': false, 'NEW BALANCE': false, 'ASICS': false, 'ONITSUKA': false });

  // Search
  const [userSearch, setUserSearch] = useState('');

  // Selected user (opens drawer)
  const [selectedUser, setSelectedUser] = useState<any | null>(null);

  // Monitor data
  const [monitor, setMonitor] = useState<any>(null);

  // Token editing per license (licenseId → draft value string)
  const [editingTokens, setEditingTokens] = useState<Record<number, string>>({});

  // Expiry editing per license (licenseId → draft date string "YYYY-MM-DD" or "")
  const [editingExpiry, setEditingExpiry] = useState<Record<number, string>>({});

  // References
  const [refs, setRefs] = useState<any[]>([]);
  const [newRefBrand, setNewRefBrand] = useState<Brand>('ADIDAS');
  const [newRefSize, setNewRefSize] = useState('');
  const [newRefType, setNewRefType] = useState<'tongue' | 'box'>('tongue');
  const [newRefImage, setNewRefImage] = useState<string | null>(null);
  const [newRefNotes, setNewRefNotes] = useState('');
  const [refUploading, setRefUploading] = useState(false);
  const refImgRef = useRef<HTMLInputElement>(null);

  const client = api(token);

  const loadTab = useCallback(async (t: Tab, search?: string) => {
    setLoading(true);
    try {
      if (t === 'stats') setStats(await client.get('/api/admin/stats'));
      else if (t === 'users') {
        const q = search !== undefined ? search : userSearch;
        const url = q ? `/api/admin/users?search=${encodeURIComponent(q)}` : '/api/admin/users';
        setUsers(await client.get(url));
      }
      else if (t === 'activity') setActivity(await client.get('/api/admin/activity'));
      else if (t === 'monitor') setMonitor(await client.get('/api/admin/monitor'));
      else if (t === 'licenses') setLicenses(await client.get('/api/admin/licenses'));
      else if (t === 'sessions') setSessions(await client.get('/api/admin/sessions'));
      else if (t === 'prompts') {
        const [tongueRows, boxRows]: [any[], any[]] = await Promise.all([
          client.get(E.TP),
          client.get(E.BP),
        ]);
        const tm: Partial<Record<Brand, string>> = {};
        tongueRows.forEach((r: any) => { if (BRANDS.includes(r.brand as Brand)) tm[r.brand as Brand] = r.prompt; });
        const bm: Partial<Record<Brand, string>> = {};
        boxRows.forEach((r: any) => { if (BRANDS.includes(r.brand as Brand)) bm[r.brand as Brand] = r.prompt; });
        setPrompts(prev => ({ ...prev, ...tm }));
        setBoxPrompts(prev => ({ ...prev, ...bm }));
      }
      else if (t === 'references') {
        setRefs(await client.get('/api/admin/label-references'));
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  const savePrompt = async (brand: Brand) => {
    setPromptSaving(prev => ({ ...prev, [brand]: true }));
    await client.post(E.ATP, { brand, prompt: prompts[brand] });
    setPromptSaving(prev => ({ ...prev, [brand]: false }));
    setPromptSaved(prev => ({ ...prev, [brand]: true }));
    setTimeout(() => setPromptSaved(prev => ({ ...prev, [brand]: false })), 2000);
  };

  const saveBoxPrompt = async (brand: Brand) => {
    setBoxPromptSaving(prev => ({ ...prev, [brand]: true }));
    await client.post('/api/admin/box/prompts', { brand, prompt: boxPrompts[brand] });
    setBoxPromptSaving(prev => ({ ...prev, [brand]: false }));
    setBoxPromptSaved(prev => ({ ...prev, [brand]: true }));
    setTimeout(() => setBoxPromptSaved(prev => ({ ...prev, [brand]: false })), 2000);
  };

  const saveLicenseTokens = async (licenseId: number) => {
    const raw = editingTokens[licenseId];
    const tokens = (raw === '' || raw === null || raw === undefined) ? null : parseInt(raw, 10);
    if (raw !== '' && tokens !== null && (isNaN(tokens) || tokens < 0)) return;
    await client.post(`/api/admin/licenses/${licenseId}/tokens`, { tokens });
    setEditingTokens(prev => { const n = { ...prev }; delete n[licenseId]; return n; });
    loadTab('licenses');
  };

  const refreshUsers = useCallback(async () => {
    const q = userSearch;
    const url = q ? `/api/admin/users?search=${encodeURIComponent(q)}` : '/api/admin/users';
    const fresh = await client.get(url);
    setUsers(fresh);
    // Sync drawer con datos frescos
    setSelectedUser((prev: any) => {
      if (!prev) return null;
      return fresh.find((u: any) => u.id === prev.id) ?? null;
    });
  }, [token, userSearch]);

  const saveLicenseExpiry = async (licenseId: number) => {
    const raw = editingExpiry[licenseId]; // "YYYY-MM-DD" o "" = lifetime
    const expires_at = raw || null;
    await client.patch(`/api/admin/licenses/${licenseId}/expires`, { expires_at });
    setEditingExpiry(prev => { const n = { ...prev }; delete n[licenseId]; return n; });
    loadTab('licenses');
  };

  // Compress image to max 900px before storing as base64
  const compressRefImg = (dataUrl: string): Promise<string> =>
    new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 900 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.src = dataUrl;
    });

  const uploadRef = async () => {
    if (!newRefImage) return;
    setRefUploading(true);
    try {
      const compressed = await compressRefImg(newRefImage);
      await client.post('/api/admin/label-references', {
        brand: newRefBrand,
        size_us: newRefSize.trim() || null,
        label_type: newRefType,
        imageBase64: compressed,
        codes: {},
        notes: newRefNotes.trim() || null,
      });
      setNewRefImage(null);
      setNewRefSize('');
      setNewRefNotes('');
      await loadTab('references');
    } finally {
      setRefUploading(false);
    }
  };

  const deleteRef = async (id: number) => {
    if (!confirm('¿Eliminar esta referencia?')) return;
    await client.delete(`/api/admin/label-references/${id}`);
    setRefs(prev => prev.filter(r => r.id !== id));
  };

  useEffect(() => { loadTab(tab); }, [tab]);

  const generateKeys = async () => {
    setGenLoading(true);
    setGeneratedKeys([]);
    const body: any = { type: genType, quantity: genQty };
    if (genType === 'custom') body.days = genDays;
    const data = await client.post('/api/admin/licenses/generate', body);
    setGeneratedKeys(data.keys || []);
    await loadTab('licenses');
    setGenLoading(false);
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'monitor',    label: 'Monitor',     icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'stats',      label: 'Stats',       icon: <Activity className="w-4 h-4" /> },
    { id: 'users',      label: 'Usuarios',    icon: <Users className="w-4 h-4" /> },
    { id: 'activity',   label: 'Actividad',   icon: <Clock className="w-4 h-4" /> },
    { id: 'licenses',   label: 'Licencias',   icon: <Key className="w-4 h-4" /> },
    { id: 'sessions',   label: 'Sesiones',    icon: <Globe className="w-4 h-4" /> },
    { id: 'prompts',    label: 'Prompts',     icon: <FileText className="w-4 h-4" /> },
    { id: 'references', label: 'Referencias', icon: <ImagePlus className="w-4 h-4" /> },
  ];

  function actionLabel(a: string): { label: string; color: string } {
    if (a === 'login') return { label: '🔑 Login', color: 'text-blue-400' };
    if (a.startsWith('lengueta:scan'))     return { label: `📷 Escaneo ${a.split(':')[2] || ''}`, color: 'text-acid' };
    if (a.startsWith('lengueta:generate')) return { label: `✨ Generación ${a.split(':')[2] || ''}`, color: 'text-violet-400' };
    return { label: a, color: 'text-zinc-400' };
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-violet-600/20 border border-violet-500/30 flex items-center justify-center">
            <Shield className="w-4 h-4 text-violet-400" />
          </div>
          <span className="font-bold text-white">Admin Panel</span>
        </div>
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className="flex items-center gap-2 text-sm text-violet-400 hover:text-violet-300 transition">
              ← Ir a la App
            </button>
          )}
          <button onClick={onLogout} className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition">
            <LogOut className="w-4 h-4" />
            Salir
          </button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-6">
        {/* Tabs */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-1">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition ${
                tab === t.id ? 'bg-violet-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700'
              }`}
            >
              {t.icon} {t.label}
            </button>
          ))}
          <button
            onClick={() => loadTab(tab)}
            className="ml-auto flex items-center gap-2 px-3 py-2 rounded-xl text-sm text-zinc-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 transition"
          >
            <RefreshCcw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Stats */}
        {tab === 'stats' && stats && (
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: 'Usuarios totales', value: stats.total_users, icon: <Users className="w-5 h-5 text-violet-400" /> },
              { label: 'Licencias activas', value: stats.active_licenses, icon: <Key className="w-5 h-5 text-acid" /> },
              { label: 'Sesiones (24h)', value: stats.sessions_24h, icon: <Activity className="w-5 h-5 text-blue-400" /> },
            ].map(s => (
              <div key={s.label} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-zinc-400">{s.label}</span>
                  {s.icon}
                </div>
                <p className="text-3xl font-bold">{s.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Users */}
        {tab === 'users' && (
          <div className="space-y-3">
            {/* Search bar */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
              <input
                type="text"
                placeholder="Buscar por usuario o email…"
                value={userSearch}
                onChange={e => setUserSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') loadTab('users', userSearch); }}
                className="w-full pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500"
              />
              <button
                onClick={() => loadTab('users', userSearch)}
                className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1 bg-violet-600 hover:bg-violet-500 rounded-lg text-xs text-white transition"
              >Buscar</button>
            </div>

            {/* Online now banner */}
            {users.filter(u => isOnline(u.last_seen_at)).length > 0 && (
              <div className="flex items-center gap-2 bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-2.5 text-sm text-green-400">
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse shrink-0" />
                <span><strong>{users.filter(u => isOnline(u.last_seen_at)).length}</strong> usuario(s) activos ahora mismo (últimos 10 min)</span>
              </div>
            )}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800">
                    {['', 'Usuario', 'Email', 'Visto', 'Hoy', 'Licencia'].map(h => (
                      <th key={h} className="text-left text-xs text-zinc-500 font-medium px-4 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => {
                    const online = isOnline(u.last_seen_at);
                    const sel = selectedUser?.id === u.id;
                    return (
                      <tr
                        key={u.id}
                        onClick={() => setSelectedUser(u)}
                        className={`border-b border-zinc-800/60 cursor-pointer transition
                          ${u.is_blocked ? 'opacity-40' : ''}
                          ${sel ? 'bg-zinc-800/70' : online ? 'bg-green-500/5 hover:bg-green-500/10' : 'hover:bg-zinc-800/40'}`}
                      >
                        <td className="px-3 py-3">
                          <span className={`w-2 h-2 rounded-full inline-block ${online ? 'bg-green-400 animate-pulse' : 'bg-zinc-700'}`} />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-medium text-white">{u.username}</span>
                            {u.is_admin && <span className="text-[10px] text-violet-400 border border-violet-500/30 rounded px-1">admin</span>}
                            {u.rank === 'pro' && <span className="text-[10px] text-yellow-400 border border-yellow-500/30 rounded px-1 inline-flex items-center gap-0.5"><Crown className="w-2.5 h-2.5" /> Pro</span>}
                            {u.is_blocked && <span className="text-[10px] text-red-400 border border-red-500/30 rounded px-1">bloqueado</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-zinc-500 truncate max-w-[180px]">{u.email}</td>
                        <td className="px-4 py-3 text-xs">
                          <span className={online ? 'text-green-400 font-medium' : 'text-zinc-400'}>{timeAgo(u.last_seen_at)}</span>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <span className={`font-mono font-semibold ${Number(u.daily_usage_today) >= 10 ? 'text-red-400' : Number(u.daily_usage_today) > 0 ? 'text-[#d4ff00]' : 'text-zinc-600'}`}>
                            {u.daily_usage_today ?? 0}/10
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {u.license_type ? <Badge type={u.license_type} /> : <span className="text-zinc-600 text-xs">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {users.length === 0 && !loading && (
                <p className="text-center text-zinc-600 py-8 text-sm">Sin usuarios — haz una búsqueda</p>
              )}
            </div>
          </div>
        )}

        {/* Activity feed */}
        {tab === 'activity' && (
          <div className="space-y-2">
            <p className="text-xs text-zinc-500 mb-3">Últimas 300 acciones · se actualiza al recargar</p>
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
              {activity.length === 0 && !loading && (
                <p className="text-center text-zinc-600 py-8 text-sm">Sin actividad todavía. Se registra a partir del próximo login.</p>
              )}
              {activity.map(a => {
                const { label, color } = actionLabel(a.action);
                return (
                  <div key={a.id} className="flex items-center gap-4 px-5 py-3 border-b border-zinc-800/60 hover:bg-zinc-800/20 transition text-sm">
                    <span className="text-zinc-600 text-xs w-32 shrink-0">{timeAgo(a.created_at)}</span>
                    <span className="font-medium text-white w-28 shrink-0 truncate">{a.username}</span>
                    <span className="text-zinc-500 text-xs w-36 shrink-0 truncate">{a.email}</span>
                    <span className={`font-medium shrink-0 ${color}`}>{label}</span>
                    <span className="text-zinc-600 text-xs ml-auto font-mono">{a.ip || '—'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Licenses */}
        {tab === 'licenses' && (
          <div className="space-y-4">
            {/* Generate */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
              <h3 className="font-semibold text-sm mb-4 flex items-center gap-2">
                <Plus className="w-4 h-4 text-violet-400" /> Generar licencias
              </h3>
              <div className="flex flex-wrap gap-3 items-end">
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Tipo</label>
                  <select
                    value={genType}
                    onChange={e => setGenType(e.target.value)}
                    className="bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"
                  >
                    <option value="trial">Trial (3 días)</option>
                    <option value="monthly">Mensual (30 días)</option>
                    <option value="lifetime">Lifetime</option>
                    <option value="custom">Custom (días)</option>
                  </select>
                </div>
                {genType === 'custom' && (
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Días</label>
                    <input
                      type="number"
                      value={genDays}
                      onChange={e => setGenDays(parseInt(e.target.value))}
                      min={1}
                      className="bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm text-white w-24 focus:outline-none focus:border-violet-500"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Cantidad (máx 50)</label>
                  <input
                    type="number"
                    value={genQty}
                    onChange={e => setGenQty(Math.min(50, parseInt(e.target.value) || 1))}
                    min={1}
                    max={50}
                    className="bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm text-white w-24 focus:outline-none focus:border-violet-500"
                  />
                </div>
                <button
                  onClick={generateKeys}
                  disabled={genLoading}
                  className="flex items-center gap-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-medium transition"
                >
                  <Plus className="w-4 h-4" />
                  {genLoading ? 'Generando…' : 'Generar'}
                </button>
              </div>

              {generatedKeys.length > 0 && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4 space-y-1.5">
                  <p className="text-xs text-zinc-400 mb-2">{generatedKeys.length} clave(s) generada(s):</p>
                  {generatedKeys.map(k => (
                    <div key={k} className="flex items-center gap-2 bg-zinc-800 rounded-xl px-3 py-2">
                      <code className="font-mono text-sm text-acid flex-1">{k}</code>
                      <CopyButton text={k} />
                    </div>
                  ))}
                  <button
                    onClick={() => navigator.clipboard.writeText(generatedKeys.join('\n'))}
                    className="text-xs text-zinc-500 hover:text-zinc-300 transition mt-1"
                  >
                    Copiar todas
                  </button>
                </motion.div>
              )}
            </div>

            {/* Table */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-x-auto">
              <table className="w-full text-sm min-w-[700px]">
                <thead>
                  <tr className="border-b border-zinc-800">
                    {['Clave', 'Tipo', 'Usuario', 'Expira', 'HWID', 'Acceso', 'Tokens', 'Activa', 'Acciones'].map(h => (
                      <th key={h} className="text-left text-xs text-zinc-500 font-medium px-4 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {licenses.map(l => {
                    const hasAcademia = (l.features || []).includes('academia') || (l.features || []).includes('all');
                    return (
                    <tr key={l.id} className={`border-b border-zinc-800/60 hover:bg-zinc-800/30 transition ${!l.is_active ? 'opacity-50' : ''}`}>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-300">
                        <div className="flex items-center">{l.key}<CopyButton text={l.key} /></div>
                      </td>
                      <td className="px-4 py-3"><Badge type={l.type} /></td>
                      <td className="px-4 py-3 text-xs text-zinc-400">{l.username || <span className="text-zinc-600">Sin activar</span>}</td>
                      <td className="px-4 py-3 text-xs">
                        {l.id in editingExpiry ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="date"
                              value={editingExpiry[l.id]}
                              onChange={e => setEditingExpiry(prev => ({ ...prev, [l.id]: e.target.value }))}
                              className="bg-zinc-800 border border-violet-500 rounded-lg px-2 py-1 text-xs text-white focus:outline-none"
                              autoFocus
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveLicenseExpiry(l.id);
                                if (e.key === 'Escape') setEditingExpiry(prev => { const n = { ...prev }; delete n[l.id]; return n; });
                              }}
                            />
                            <button onClick={() => saveLicenseExpiry(l.id)} className="text-acid text-xs px-1.5 py-1 rounded hover:text-white transition">✓</button>
                            <button onClick={() => setEditingExpiry(prev => { const n = { ...prev }; delete n[l.id]; return n; })} className="text-zinc-500 text-xs px-1 py-1 rounded hover:text-white transition">✕</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => {
                              const d = l.expires_at ? new Date(l.expires_at).toISOString().slice(0, 10) : '';
                              setEditingExpiry(prev => ({ ...prev, [l.id]: d }));
                            }}
                            className="text-zinc-400 hover:text-white hover:underline transition cursor-pointer"
                            title="Editar fecha de expiración"
                          >
                            {formatDate(l.expires_at)}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-500 max-w-[90px] truncate" title={l.hwid || ''}>{truncate(l.hwid, 10)}</td>

                      {/* Columna de acceso academia */}
                      <td className="px-4 py-3">
                        <button
                          onClick={async () => {
                            const newFeatures = hasAcademia ? ['photos'] : ['photos', 'academia'];
                            await client.patch(`/api/admin/licenses/${l.id}/features`, { features: newFeatures });
                            loadTab('licenses');
                          }}
                          title={hasAcademia ? 'Quitar acceso academia' : 'Dar acceso academia'}
                          className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg border transition ${
                            hasAcademia
                              ? 'bg-acid/10 border-acid/30 text-acid hover:bg-acid/20'
                              : 'bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300'
                          }`}
                        >
                          {hasAcademia ? '🎓 Academia' : '🔒 Solo Fantasma'}
                        </button>
                      </td>

                      {/* Columna tokens */}
                      <td className="px-4 py-3">
                        {l.id in editingTokens ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="number" min={0} placeholder="∞"
                              value={editingTokens[l.id]}
                              onChange={e => setEditingTokens(prev => ({ ...prev, [l.id]: e.target.value }))}
                              className="w-16 bg-zinc-800 border border-violet-500 rounded-lg px-2 py-1 text-xs text-white focus:outline-none"
                              autoFocus
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveLicenseTokens(l.id);
                                if (e.key === 'Escape') setEditingTokens(prev => { const n = { ...prev }; delete n[l.id]; return n; });
                              }}
                            />
                            <button onClick={() => saveLicenseTokens(l.id)} className="text-acid text-xs px-1.5 py-1 rounded hover:text-white transition">✓</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setEditingTokens(prev => ({ ...prev, [l.id]: l.image_tokens ?? '' }))}
                            className="text-xs text-zinc-400 hover:text-white font-mono flex items-center gap-1 transition"
                            title="Editar tokens"
                          >
                            🪙 {l.image_tokens === null || l.image_tokens === undefined ? '∞' : l.image_tokens}
                          </button>
                        )}
                      </td>

                      <td className="px-4 py-3">
                        <button
                          onClick={async () => {
                            const newFeatures = hasAcademia ? ['photos'] : ['photos', 'academia'];
                            await client.patch(`/api/admin/licenses/${l.id}/features`, { features: newFeatures });
                            loadTab('licenses');
                          }}
                          className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${
                            hasAcademia
                              ? 'bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20'
                              : 'bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300'
                          }`}
                        >
                          {hasAcademia ? '🎓 Academia' : '👻 Solo Fantasma'}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium ${l.is_active ? 'text-acid' : 'text-red-400'}`}>
                          {l.is_active ? 'Sí' : 'No'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={async () => { await client.patch(`/api/admin/licenses/${l.id}/toggle`); loadTab('licenses'); }}
                            title={l.is_active ? 'Desactivar' : 'Activar'}
                            className="text-zinc-500 hover:text-violet-400 transition"
                          >
                            {l.is_active ? <ToggleRight className="w-4 h-4 text-acid" /> : <ToggleLeft className="w-4 h-4" />}
                          </button>
                          <button
                            onClick={async () => { await client.patch(`/api/admin/licenses/${l.id}/reset-hwid`); loadTab('licenses'); }}
                            title="Reset HWID/IP"
                            className="text-zinc-500 hover:text-yellow-400 transition"
                          >
                            <Fingerprint className="w-4 h-4" />
                          </button>
                          <button
                            onClick={async () => { if (confirm('¿Eliminar esta licencia?')) { await client.delete(`/api/admin/licenses/${l.id}`); loadTab('licenses'); } }}
                            title="Eliminar"
                            className="text-zinc-500 hover:text-red-400 transition"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              {licenses.length === 0 && !loading && (
                <p className="text-center text-zinc-600 py-8 text-sm">Sin licencias todavía</p>
              )}
            </div>
          </div>
        )}

        {/* Prompts */}
        {tab === 'prompts' && (
          <div className="space-y-4">
            <p className="text-sm text-zinc-400">
              Prompts personalizados por marca. Se aplican automáticamente a todos los usuarios al generar.
            </p>
            {BRANDS.map(brand => (
              <motion.div key={brand} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-5"
              >
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  <FileText className="w-4 h-4 text-violet-400" /> {brand}
                </h3>

                {/* Lengüeta */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Prompt Lengüeta</span>
                    <button onClick={() => savePrompt(brand)} disabled={promptSaving[brand]}
                      className="flex items-center gap-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white px-3 py-1.5 rounded-xl text-xs font-medium transition"
                    >
                      {promptSaved[brand] ? <><Check className="w-3.5 h-3.5 text-green-300" /> Guardado</> : promptSaving[brand] ? <><RefreshCcw className="w-3.5 h-3.5 animate-spin" /> Guardando…</> : <><Save className="w-3.5 h-3.5" /> Guardar Lengüeta</>}
                    </button>
                  </div>
                  <textarea value={prompts[brand]} onChange={e => setPrompts(prev => ({ ...prev, [brand]: e.target.value }))}
                    rows={6} placeholder={`Prompt base para lengüeta ${brand}…`}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-violet-500 resize-y font-mono leading-relaxed"
                  />
                </div>

                <div className="border-t border-zinc-800" />

                {/* Caja */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-400 font-medium uppercase tracking-wider flex items-center gap-1.5">
                      <Package className="w-3.5 h-3.5 text-acid" /> Prompt Caja
                    </span>
                    <button onClick={() => saveBoxPrompt(brand)} disabled={boxPromptSaving[brand]}
                      className="flex items-center gap-1.5 bg-acid/20 hover:bg-acid/30 border border-acid/40 disabled:opacity-50 text-acid px-3 py-1.5 rounded-xl text-xs font-medium transition"
                    >
                      {boxPromptSaved[brand] ? <><Check className="w-3.5 h-3.5" /> Guardado</> : boxPromptSaving[brand] ? <><RefreshCcw className="w-3.5 h-3.5 animate-spin" /> Guardando…</> : <><Save className="w-3.5 h-3.5" /> Guardar Caja</>}
                    </button>
                  </div>
                  <textarea value={boxPrompts[brand]} onChange={e => setBoxPrompts(prev => ({ ...prev, [brand]: e.target.value }))}
                    rows={6} placeholder={`Prompt base para etiqueta de caja ${brand}…`}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-acid/50 resize-y font-mono leading-relaxed"
                  />
                </div>
              </motion.div>
            ))}
          </div>
        )}

        {/* References */}
        {tab === 'references' && (
          <div className="space-y-6">
            {/* Upload form */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 space-y-4">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <ImagePlus className="w-4 h-4 text-violet-400" /> Subir imagen de referencia
              </h3>
              <p className="text-xs text-zinc-500">Sube la foto real de la etiqueta original. Se usará como guía de tipografía y disposición para el motor de IA.</p>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Marca</label>
                  <select value={newRefBrand} onChange={e => setNewRefBrand(e.target.value as Brand)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"
                  >
                    {BRANDS.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Talla US (vacío = genérica)</label>
                  <input value={newRefSize} onChange={e => setNewRefSize(e.target.value)} placeholder="ej: 10.5"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                {(['tongue', 'box'] as const).map(t => (
                  <button key={t} onClick={() => setNewRefType(t)}
                    className={`flex-1 py-2 rounded-xl text-sm font-medium border transition ${
                      newRefType === t
                        ? t === 'tongue' ? 'bg-violet-600 border-violet-600 text-white' : 'bg-acid/20 border-acid/50 text-acid'
                        : 'bg-zinc-800 border-zinc-700 text-zinc-500 hover:text-white'
                    }`}
                  >
                    {t === 'tongue' ? '👟 Lengüeta' : '📦 Etiqueta Caja'}
                  </button>
                ))}
              </div>

              <div
                onClick={() => refImgRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition ${
                  newRefImage ? 'border-violet-500/50 bg-violet-500/5' : 'border-zinc-700 hover:border-zinc-500'
                }`}
              >
                {newRefImage ? (
                  <div className="space-y-2">
                    <img src={newRefImage} className="max-h-40 mx-auto rounded-lg object-contain" />
                    <p className="text-xs text-zinc-500">Clic para cambiar</p>
                  </div>
                ) : (
                  <div className="space-y-2 py-4">
                    <ImagePlus className="w-8 h-8 text-zinc-600 mx-auto" />
                    <p className="text-sm text-zinc-500">Clic para subir foto de referencia</p>
                    <p className="text-xs text-zinc-600">JPEG / PNG — se comprimirá a 900px</p>
                  </div>
                )}
                <input type="file" ref={refImgRef} accept="image/*" className="hidden"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onloadend = () => setNewRefImage(reader.result as string);
                    reader.readAsDataURL(file);
                  }}
                />
              </div>

              <input value={newRefNotes} onChange={e => setNewRefNotes(e.target.value)} placeholder="Notas opcionales (ej: 'NB 574 talla EU 42')"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"
              />

              <button onClick={uploadRef} disabled={refUploading || !newRefImage}
                className="flex items-center gap-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-medium transition w-full justify-center"
              >
                {refUploading ? <><RefreshCcw className="w-4 h-4 animate-spin" /> Subiendo…</> : <><ImagePlus className="w-4 h-4" /> Subir referencia</>}
              </button>
            </div>

            {/* Table */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-x-auto">
              <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between">
                <h3 className="text-sm font-semibold flex items-center gap-2"><Hash className="w-4 h-4 text-zinc-500" /> Referencias almacenadas ({refs.length})</h3>
                <button onClick={() => loadTab('references')} className="text-zinc-500 hover:text-zinc-300 transition">
                  <RefreshCcw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <table className="w-full text-sm min-w-[500px]">
                <thead>
                  <tr className="border-b border-zinc-800">
                    {['Marca', 'Talla', 'Tipo', 'Notas', 'Fecha', ''].map(h => (
                      <th key={h} className="text-left text-xs text-zinc-500 font-medium px-4 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {refs.map(r => (
                    <tr key={r.id} className="border-b border-zinc-800/60 hover:bg-zinc-800/30 transition">
                      <td className="px-4 py-3 text-sm font-medium">{r.brand}</td>
                      <td className="px-4 py-3 text-xs text-zinc-400">{r.size_us || <span className="text-zinc-600 italic">Genérica</span>}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${
                          r.label_type === 'tongue' ? 'bg-violet-500/10 text-violet-400 border-violet-500/30' : 'bg-acid-soft text-acid border-acid/30'
                        }`}>
                          {r.label_type === 'tongue' ? '👟 Lengüeta' : '📦 Caja'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-500 max-w-[160px] truncate">{r.notes || '—'}</td>
                      <td className="px-4 py-3 text-xs text-zinc-500">{formatDate(r.created_at)}</td>
                      <td className="px-4 py-3">
                        <button onClick={() => deleteRef(r.id)} title="Eliminar" className="text-zinc-600 hover:text-red-400 transition">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {refs.length === 0 && !loading && (
                    <tr><td colSpan={6} className="text-center text-zinc-600 py-8 text-sm">Sin referencias todavía</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Monitor */}
        {tab === 'monitor' && (
          <div className="space-y-4">
            {!monitor && !loading && (
              <div className="flex justify-center py-12">
                <button onClick={() => loadTab('monitor')} className="flex items-center gap-2 px-5 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-sm transition">
                  <RefreshCcw className="w-4 h-4" /> Cargar métricas
                </button>
              </div>
            )}
            {loading && (
              <div className="flex justify-center py-12 text-zinc-500 text-sm gap-2">
                <RefreshCcw className="w-4 h-4 animate-spin" /> Obteniendo métricas…
              </div>
            )}
            {monitor && (
              <>
                {/* Status + Uptime row */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className={`bg-zinc-900 border rounded-2xl p-4 flex flex-col gap-1 ${monitor.status === 'ok' ? 'border-green-500/30' : 'border-red-500/30'}`}>
                    <span className="text-xs text-zinc-500 uppercase tracking-wider">Estado</span>
                    <span className={`text-lg font-bold ${monitor.status === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
                      {monitor.status === 'ok' ? '✅ ONLINE' : '❌ ERROR'}
                    </span>
                    <span className="text-xs text-zinc-500">DB {monitor.db_latency_ms}ms</span>
                  </div>
                  <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 flex flex-col gap-1">
                    <span className="text-xs text-zinc-500 uppercase tracking-wider">Uptime</span>
                    <span className="text-lg font-bold text-white font-mono">
                      {(() => {
                        const s = monitor.uptime_s || 0;
                        const h = Math.floor(s / 3600);
                        const m = Math.floor((s % 3600) / 60);
                        return h > 0 ? `${h}h ${m}m` : `${m}m`;
                      })()}
                    </span>
                    <span className="text-xs text-zinc-500">Node {monitor.node_version}</span>
                  </div>
                  <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 flex flex-col gap-1">
                    <span className="text-xs text-zinc-500 uppercase tracking-wider flex items-center gap-1"><Cpu className="w-3.5 h-3.5" /> RAM Usada</span>
                    <span className="text-lg font-bold text-white font-mono">{monitor.mem_mb?.rss} MB</span>
                    <span className="text-xs text-zinc-500">Heap {monitor.mem_mb?.heapUsed}/{monitor.mem_mb?.heapTotal} MB</span>
                  </div>
                  <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 flex flex-col gap-1">
                    <span className="text-xs text-zinc-500 uppercase tracking-wider flex items-center gap-1"><Database className="w-3.5 h-3.5" /> DB Latencia</span>
                    <span className={`text-lg font-bold font-mono ${Number(monitor.db_latency_ms) < 50 ? 'text-green-400' : Number(monitor.db_latency_ms) < 200 ? 'text-yellow-400' : 'text-red-400'}`}>
                      {monitor.db_latency_ms}ms
                    </span>
                    <span className="text-xs text-zinc-500">PostgreSQL</span>
                  </div>
                </div>

                {/* Metrics grid */}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {[
                    { label: 'Usuarios totales', value: monitor.metrics?.total_users, icon: <Users className="w-4 h-4 text-violet-400" /> },
                    { label: 'Activos (24h)', value: monitor.metrics?.active_users_24h, icon: <Activity className="w-4 h-4 text-green-400" /> },
                    { label: 'Nuevos hoy', value: monitor.metrics?.new_users_today, icon: <TrendingUp className="w-4 h-4 text-blue-400" /> },
                    { label: 'Generaciones hoy', value: monitor.metrics?.generations_today, icon: <Zap className="w-4 h-4 text-acid" /> },
                    { label: 'Generaciones total', value: monitor.metrics?.generations_total, icon: <BarChart3 className="w-4 h-4 text-zinc-400" /> },
                    { label: 'Licencias activas', value: monitor.metrics?.active_licenses, icon: <Key className="w-4 h-4 text-yellow-400" /> },
                    { label: 'Usuarios bloqueados', value: monitor.metrics?.blocked_users, icon: <Ban className="w-4 h-4 text-red-400" /> },
                    { label: 'Errores proxy (24h)', value: monitor.metrics?.errors_proxy_24h, icon: <AlertTriangle className="w-4 h-4 text-orange-400" /> },
                  ].map(m => (
                    <div key={m.label} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-zinc-800 flex items-center justify-center shrink-0">{m.icon}</div>
                      <div>
                        <p className="text-xs text-zinc-500">{m.label}</p>
                        <p className="text-xl font-bold text-white">{m.value ?? '—'}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Top users today */}
                {monitor.top_users_today?.length > 0 && (
                  <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
                    <div className="px-5 py-3 border-b border-zinc-800 flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-acid" />
                      <h3 className="text-sm font-semibold">Top usuarios hoy</h3>
                    </div>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-zinc-800">
                          <th className="text-left text-xs text-zinc-500 px-5 py-2">#</th>
                          <th className="text-left text-xs text-zinc-500 px-4 py-2">Usuario</th>
                          <th className="text-right text-xs text-zinc-500 px-5 py-2">Generaciones</th>
                        </tr>
                      </thead>
                      <tbody>
                        {monitor.top_users_today.map((u: any, i: number) => (
                          <tr key={u.user_id} className="border-b border-zinc-800/60 hover:bg-zinc-800/20">
                            <td className="px-5 py-2 text-zinc-500 text-xs font-mono">{i + 1}</td>
                            <td className="px-4 py-2 font-medium">{u.username || `ID ${u.user_id}`}</td>
                            <td className="px-5 py-2 text-right">
                              <span className="font-mono font-bold text-acid">{u.count}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <p className="text-xs text-zinc-600 text-right">
                  Actualizado: {new Date(monitor.checked_at).toLocaleTimeString('es-ES')}
                  <button onClick={() => loadTab('monitor')} className="ml-3 text-zinc-500 hover:text-zinc-300 transition inline-flex items-center gap-1">
                    <RefreshCcw className="w-3 h-3" /> Refresh
                  </button>
                </p>
              </>
            )}
          </div>
        )}

        {/* Sessions */}
        {tab === 'sessions' && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-x-auto">
            <table className="w-full text-sm min-w-[600px]">
              <thead>
                <tr className="border-b border-zinc-800">
                  {['Usuario', 'IP', 'HWID', 'Creada', 'Última actividad'].map(h => (
                    <th key={h} className="text-left text-xs text-zinc-500 font-medium px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sessions.map(s => (
                  <tr key={s.id} className="border-b border-zinc-800/60 hover:bg-zinc-800/30 transition">
                    <td className="px-4 py-3 font-medium text-sm">{s.username || '—'}</td>
                    <td className="px-4 py-3 text-xs text-zinc-400 font-mono">{s.ip || '—'}</td>
                    <td className="px-4 py-3 text-xs text-zinc-500 max-w-[120px] truncate" title={s.hwid || ''}>
                      <Fingerprint className="inline w-3 h-3 mr-1" />{truncate(s.hwid, 12)}
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-400">{formatDate(s.created_at)}</td>
                    <td className="px-4 py-3 text-xs text-zinc-400 flex items-center gap-1">
                      <Clock className="w-3 h-3" />{formatDate(s.last_seen)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sessions.length === 0 && !loading && (
              <p className="text-center text-zinc-600 py-8 text-sm">Sin sesiones registradas</p>
            )}
          </div>
        )}
      </div>

      {/* User drawer */}
      {selectedUser && (
        <UserDrawer
          user={selectedUser}
          token={token}
          onClose={() => setSelectedUser(null)}
          onRefresh={refreshUsers}
        />
      )}
    </div>
  );
}
