import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';
import {
  Users, Key, Activity, LogOut, Plus, Trash2,
  RefreshCcw, Shield, ShieldOff, Copy, Check,
  ToggleLeft, ToggleRight, Fingerprint, Globe, Clock
} from 'lucide-react';

interface AdminPanelProps {
  token: string;
  onLogout: () => void;
}

type Tab = 'stats' | 'users' | 'licenses' | 'sessions';

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
    custom: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
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

export default function AdminPanel({ token, onLogout }: AdminPanelProps) {
  const [tab, setTab] = useState<Tab>('stats');
  const [stats, setStats] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [licenses, setLicenses] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Generate form
  const [genType, setGenType] = useState('monthly');
  const [genQty, setGenQty] = useState(1);
  const [genDays, setGenDays] = useState(7);
  const [generatedKeys, setGeneratedKeys] = useState<string[]>([]);
  const [genLoading, setGenLoading] = useState(false);

  const client = api(token);

  const loadTab = useCallback(async (t: Tab) => {
    setLoading(true);
    try {
      if (t === 'stats') setStats(await client.get('/api/admin/stats'));
      else if (t === 'users') setUsers(await client.get('/api/admin/users'));
      else if (t === 'licenses') setLicenses(await client.get('/api/admin/licenses'));
      else if (t === 'sessions') setSessions(await client.get('/api/admin/sessions'));
    } finally {
      setLoading(false);
    }
  }, [token]);

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
    { id: 'stats', label: 'Stats', icon: <Activity className="w-4 h-4" /> },
    { id: 'users', label: 'Usuarios', icon: <Users className="w-4 h-4" /> },
    { id: 'licenses', label: 'Licencias', icon: <Key className="w-4 h-4" /> },
    { id: 'sessions', label: 'Sesiones', icon: <Globe className="w-4 h-4" /> },
  ];

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
        <button onClick={onLogout} className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition">
          <LogOut className="w-4 h-4" />
          Salir
        </button>
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
              { label: 'Licencias activas', value: stats.active_licenses, icon: <Key className="w-5 h-5 text-emerald-400" /> },
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
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-x-auto">
            <table className="w-full text-sm min-w-[600px]">
              <thead>
                <tr className="border-b border-zinc-800">
                  {['Usuario', 'Email', 'Licencia', 'Tipo', 'Expira', 'HWID', 'IP', 'Rol', ''].map(h => (
                    <th key={h} className="text-left text-xs text-zinc-500 font-medium px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className="border-b border-zinc-800/60 hover:bg-zinc-800/30 transition">
                    <td className="px-4 py-3 font-medium">{u.username}</td>
                    <td className="px-4 py-3 text-zinc-400 text-xs">{u.email}</td>
                    <td className="px-4 py-3">
                      {u.license_key ? (
                        <span className="font-mono text-xs text-zinc-300 flex items-center">
                          {truncate(u.license_key, 14)}
                          <CopyButton text={u.license_key} />
                        </span>
                      ) : <span className="text-zinc-600 text-xs">Sin licencia</span>}
                    </td>
                    <td className="px-4 py-3">{u.license_type ? <Badge type={u.license_type} /> : '—'}</td>
                    <td className="px-4 py-3 text-xs text-zinc-400">{formatDate(u.expires_at)}</td>
                    <td className="px-4 py-3 text-xs text-zinc-500 flex items-center">
                      <Fingerprint className="w-3 h-3 mr-1" />{truncate(u.hwid, 10)}
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-500">{u.ip || '—'}</td>
                    <td className="px-4 py-3">
                      {u.is_admin
                        ? <span className="text-xs text-violet-400 font-medium">Admin</span>
                        : <span className="text-xs text-zinc-500">User</span>}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={async () => { await client.patch(`/api/admin/users/${u.id}/toggle-admin`); loadTab('users'); }}
                        className="text-xs text-zinc-500 hover:text-violet-400 transition"
                        title={u.is_admin ? 'Quitar admin' : 'Hacer admin'}
                      >
                        {u.is_admin ? <ShieldOff className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {users.length === 0 && !loading && (
              <p className="text-center text-zinc-600 py-8 text-sm">Sin usuarios todavía</p>
            )}
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
                      <code className="font-mono text-sm text-emerald-400 flex-1">{k}</code>
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
              <table className="w-full text-sm min-w-[600px]">
                <thead>
                  <tr className="border-b border-zinc-800">
                    {['Clave', 'Tipo', 'Usuario', 'Expira', 'HWID', 'IP', 'Activa', 'Acciones'].map(h => (
                      <th key={h} className="text-left text-xs text-zinc-500 font-medium px-4 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {licenses.map(l => (
                    <tr key={l.id} className={`border-b border-zinc-800/60 hover:bg-zinc-800/30 transition ${!l.is_active ? 'opacity-50' : ''}`}>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-300 flex items-center">
                        {l.key}<CopyButton text={l.key} />
                      </td>
                      <td className="px-4 py-3"><Badge type={l.type} /></td>
                      <td className="px-4 py-3 text-xs text-zinc-400">{l.username || <span className="text-zinc-600">Sin activar</span>}</td>
                      <td className="px-4 py-3 text-xs text-zinc-400">{formatDate(l.expires_at)}</td>
                      <td className="px-4 py-3 text-xs text-zinc-500 max-w-[100px] truncate" title={l.hwid || ''}>{truncate(l.hwid, 12)}</td>
                      <td className="px-4 py-3 text-xs text-zinc-500">{l.ip || '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium ${l.is_active ? 'text-emerald-400' : 'text-red-400'}`}>
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
                            {l.is_active ? <ToggleRight className="w-4 h-4 text-emerald-400" /> : <ToggleLeft className="w-4 h-4" />}
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
                  ))}
                </tbody>
              </table>
              {licenses.length === 0 && !loading && (
                <p className="text-center text-zinc-600 py-8 text-sm">Sin licencias todavía</p>
              )}
            </div>
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
    </div>
  );
}
