import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  TrendingUp, TrendingDown, DollarSign, BarChart2,
  Plus, Trash2, Download, Upload, X, User, ChevronDown
} from 'lucide-react';
import * as XLSX from 'xlsx';

type Period = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'biannual' | 'total';
interface Sale { id: number; model: string; buy_price: number; sell_price: number; date: string; vinted_account: string | null; }
interface Account { id: number; username: string; }

const PERIODS: { key: Period; label: string }[] = [
  { key: 'daily', label: 'Hoy' },
  { key: 'weekly', label: 'Semana' },
  { key: 'monthly', label: 'Mes' },
  { key: 'quarterly', label: 'Trimestre' },
  { key: 'biannual', label: 'Semestre' },
  { key: 'total', label: 'Total' },
];

function filterByPeriod(sales: Sale[], period: Period): Sale[] {
  if (period === 'total') return sales;
  const now = new Date();
  const from = new Date();
  if (period === 'daily') from.setHours(0, 0, 0, 0);
  else if (period === 'weekly') from.setDate(now.getDate() - 7);
  else if (period === 'monthly') from.setMonth(now.getMonth() - 1);
  else if (period === 'quarterly') from.setMonth(now.getMonth() - 3);
  else if (period === 'biannual') from.setMonth(now.getMonth() - 6);
  return sales.filter(s => new Date(s.date) >= from);
}

function calcStats(sales: Sale[]) {
  const revenue = sales.reduce((a, s) => a + Number(s.sell_price), 0);
  const costs = sales.reduce((a, s) => a + Number(s.buy_price), 0);
  const profit = revenue - costs;
  const net = profit * 0.95; // ~5% fees Vinted
  return { revenue, costs, profit, net };
}

const fmt = (n: number) => n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

export default function ProfitControl({ token }: { token: string }) {
  const [period, setPeriod] = useState<Period>('monthly');
  const [sales, setSales] = useState<Sale[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

  const [showAddSale, setShowAddSale] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [newAccount, setNewAccount] = useState('');
  const [bulkText, setBulkText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState({ model: '', buy_price: '', sell_price: '', date: new Date().toISOString().split('T')[0], vinted_account: '' });

  const authFetch = (url: string, opts: RequestInit = {}) =>
    fetch(url, { ...opts, headers: { ...(opts.headers as any), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

  const load = async () => {
    const [s, a] = await Promise.all([
      authFetch('/api/profits/sales').then(r => r.json()),
      authFetch('/api/profits/accounts').then(r => r.json()),
    ]);
    setSales(Array.isArray(s) ? s : []);
    setAccounts(Array.isArray(a) ? a : []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const filtered = filterByPeriod(sales, period);
  const stats = calcStats(filtered);

  const addSale = async () => {
    if (!form.model || !form.buy_price || !form.sell_price || !form.date) return;
    await authFetch('/api/profits/sales', { method: 'POST', body: JSON.stringify({ ...form, buy_price: parseFloat(form.buy_price), sell_price: parseFloat(form.sell_price) }) });
    setForm({ model: '', buy_price: '', sell_price: '', date: new Date().toISOString().split('T')[0], vinted_account: '' });
    setShowAddSale(false);
    load();
  };

  const deleteSale = async (id: number) => {
    await authFetch(`/api/profits/sales/${id}`, { method: 'DELETE' });
    load();
  };

  const addAccount = async () => {
    if (!newAccount.trim()) return;
    await authFetch('/api/profits/accounts', { method: 'POST', body: JSON.stringify({ username: newAccount.trim() }) });
    setNewAccount('');
    setShowAddAccount(false);
    load();
  };

  const deleteAccount = async (id: number) => {
    await authFetch(`/api/profits/accounts/${id}`, { method: 'DELETE' });
    load();
  };

  const addBulk = async () => {
    const rows = bulkText.trim().split('\n').map(line => {
      const parts = line.split(/[\t;,]/).map(p => p.trim());
      if (parts.length < 4) return null;
      return { model: parts[0], buy_price: parseFloat(parts[1]), sell_price: parseFloat(parts[2]), date: parts[3], vinted_account: parts[4] || null };
    }).filter(Boolean);
    if (!rows.length) return;
    await authFetch('/api/profits/sales', { method: 'POST', body: JSON.stringify(rows) });
    setBulkText('');
    setShowBulk(false);
    load();
  };

  const importExcel = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const wb = XLSX.read(ev.target?.result, { type: 'binary' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json<any>(ws);
      const rows = data.map((r: any) => ({
        model: r['Modelo'] || r['model'] || '',
        buy_price: parseFloat(r['Precio Compra'] || r['buy_price'] || 0),
        sell_price: parseFloat(r['Precio Venta'] || r['sell_price'] || 0),
        date: r['Fecha'] || r['date'] || new Date().toISOString().split('T')[0],
        vinted_account: r['Cuenta'] || r['vinted_account'] || null,
      })).filter((r: any) => r.model);
      await authFetch('/api/profits/sales', { method: 'POST', body: JSON.stringify(rows) });
      load();
    };
    reader.readAsBinaryString(file);
    e.target.value = '';
  };

  const exportExcel = () => {
    const data = filtered.map(s => ({
      'Modelo': s.model,
      'Precio Compra': Number(s.buy_price),
      'Precio Venta': Number(s.sell_price),
      'Beneficio': Number(s.sell_price) - Number(s.buy_price),
      'Fecha': s.date,
      'Cuenta': s.vinted_account || '',
    }));
    const totals = { 'Modelo': 'TOTAL', 'Precio Compra': stats.costs, 'Precio Venta': stats.revenue, 'Beneficio': stats.profit, 'Fecha': '', 'Cuenta': '' };
    const ws = XLSX.utils.json_to_sheet([...data, totals]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ventas');
    XLSX.writeFile(wb, `founderclub-ventas-${period}-${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const accountStats = (username: string) => {
    const acSales = sales.filter(s => s.vinted_account === username);
    return { count: acSales.length, profit: acSales.reduce((a, s) => a + Number(s.sell_price) - Number(s.buy_price), 0) };
  };

  const statCards = [
    { label: 'Facturación', value: stats.revenue, icon: <BarChart2 className="w-5 h-5" />, color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20' },
    { label: 'Gastos', value: stats.costs, icon: <TrendingDown className="w-5 h-5" />, color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' },
    { label: 'Beneficios', value: stats.profit, icon: <TrendingUp className="w-5 h-5" />, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
    { label: 'Net Profit', value: stats.net, icon: <DollarSign className="w-5 h-5" />, color: 'text-violet-400', bg: 'bg-violet-500/10 border-violet-500/20' },
  ];

  if (loading) return <div className="flex items-center justify-center py-20"><div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" /></div>;

  return (
    <div className="space-y-6 pb-24 lg:pb-6">

      {/* Period selector */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {PERIODS.map(p => (
          <button key={p.key} onClick={() => setPeriod(p.key)}
            className={`px-4 py-2 rounded-xl text-xs font-bold tracking-widest whitespace-nowrap transition-all border ${period === p.key ? 'bg-emerald-500 border-emerald-400 text-black' : 'bg-white/5 border-white/10 text-white/40 hover:bg-white/10'}`}>
            {p.label}
          </button>
        ))}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {statCards.map(c => (
          <div key={c.label} className={`rounded-2xl border p-4 ${c.bg}`}>
            <div className={`flex items-center gap-2 mb-2 ${c.color}`}>{c.icon}<span className="text-[10px] uppercase tracking-widest font-bold">{c.label}</span></div>
            <p className={`text-xl font-bold ${c.color}`}>{fmt(c.value)}</p>
            <p className="text-[10px] text-white/30 mt-1">{filtered.length} ventas</p>
          </div>
        ))}
      </div>

      {/* Accounts */}
      <div className="bg-[#141414] border border-white/5 rounded-3xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xs uppercase tracking-[0.2em] font-bold text-white/40 flex items-center gap-2"><User className="w-4 h-4" />Cuentas Vinted</h3>
          <button onClick={() => setShowAddAccount(true)} className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 transition">
            <Plus className="w-4 h-4" /> Añadir
          </button>
        </div>
        {accounts.length === 0 ? (
          <p className="text-[11px] text-white/20 text-center py-4">No hay cuentas. Añade una para filtrar ventas.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {accounts.map(a => {
              const ast = accountStats(a.username);
              return (
                <div key={a.id} className="bg-white/5 border border-white/10 rounded-2xl p-4 flex items-start justify-between">
                  <div>
                    <p className="font-bold text-sm text-white">@{a.username}</p>
                    <p className="text-[10px] text-white/40 mt-1">{ast.count} ventas · {fmt(ast.profit)} beneficio</p>
                  </div>
                  <button onClick={() => deleteAccount(a.id)} className="text-white/20 hover:text-red-400 transition">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <AnimatePresence>
          {showAddAccount && (
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="mt-4 flex gap-2">
              <input value={newAccount} onChange={e => setNewAccount(e.target.value)} onKeyDown={e => e.key === 'Enter' && addAccount()}
                placeholder="@usuario" className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:border-emerald-500/50 outline-none" autoFocus />
              <button onClick={addAccount} className="px-4 py-2 bg-emerald-500 text-black font-bold rounded-xl text-sm hover:bg-emerald-400 transition">OK</button>
              <button onClick={() => setShowAddAccount(false)} className="px-3 py-2 bg-white/5 text-white/40 rounded-xl hover:bg-white/10 transition"><X className="w-4 h-4" /></button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Sales table */}
      <div className="bg-[#141414] border border-white/5 rounded-3xl p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h3 className="text-xs uppercase tracking-[0.2em] font-bold text-white/40">Ventas ({filtered.length})</h3>
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => setShowBulk(true)} className="flex items-center gap-1 text-xs text-white/40 hover:text-white transition border border-white/10 px-3 py-1.5 rounded-lg">
              <Plus className="w-3.5 h-3.5" /> Masivo
            </button>
            <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1 text-xs text-white/40 hover:text-white transition border border-white/10 px-3 py-1.5 rounded-lg">
              <Upload className="w-3.5 h-3.5" /> Excel
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={importExcel} />
            <button onClick={exportExcel} className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 transition border border-emerald-500/30 px-3 py-1.5 rounded-lg">
              <Download className="w-3.5 h-3.5" /> Exportar
            </button>
            <button onClick={() => setShowAddSale(true)} className="flex items-center gap-1 text-xs bg-emerald-500 text-black font-bold px-3 py-1.5 rounded-lg hover:bg-emerald-400 transition">
              <Plus className="w-3.5 h-3.5" /> Añadir
            </button>
          </div>
        </div>

        {/* Add sale form */}
        <AnimatePresence>
          {showAddSale && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
              className="mb-4 bg-white/5 border border-white/10 rounded-2xl p-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="col-span-2 sm:col-span-1">
                <label className="text-[9px] uppercase text-white/30 block mb-1">Modelo</label>
                <input value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} placeholder="Nike Air Max 90" className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-emerald-500/50" />
              </div>
              <div>
                <label className="text-[9px] uppercase text-white/30 block mb-1">Precio Compra</label>
                <input type="number" value={form.buy_price} onChange={e => setForm({ ...form, buy_price: e.target.value })} placeholder="0.00" className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-emerald-500/50" />
              </div>
              <div>
                <label className="text-[9px] uppercase text-white/30 block mb-1">Precio Venta</label>
                <input type="number" value={form.sell_price} onChange={e => setForm({ ...form, sell_price: e.target.value })} placeholder="0.00" className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-emerald-500/50" />
              </div>
              <div>
                <label className="text-[9px] uppercase text-white/30 block mb-1">Fecha</label>
                <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-emerald-500/50" />
              </div>
              <div>
                <label className="text-[9px] uppercase text-white/30 block mb-1">Cuenta Vinted</label>
                <select value={form.vinted_account} onChange={e => setForm({ ...form, vinted_account: e.target.value })} className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-emerald-500/50">
                  <option value="">Sin cuenta</option>
                  {accounts.map(a => <option key={a.id} value={a.username}>@{a.username}</option>)}
                </select>
              </div>
              <div className="col-span-2 sm:col-span-3 flex gap-2 justify-end">
                <button onClick={() => setShowAddSale(false)} className="px-4 py-2 text-xs text-white/40 border border-white/10 rounded-lg hover:bg-white/5 transition">Cancelar</button>
                <button onClick={addSale} className="px-4 py-2 bg-emerald-500 text-black font-bold text-xs rounded-lg hover:bg-emerald-400 transition">Guardar</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Bulk add */}
        <AnimatePresence>
          {showBulk && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-4 bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">
              <p className="text-[10px] text-white/40">Una línea por venta. Columnas separadas por coma, tab o punto y coma:<br />
                <span className="text-white/60 font-mono">Modelo, Precio compra, Precio venta, Fecha (YYYY-MM-DD), @cuenta</span>
              </p>
              <textarea value={bulkText} onChange={e => setBulkText(e.target.value)} rows={5} placeholder={"Nike Samba, 40, 85, 2025-01-15, usuario1\nAdidas NMD, 60, 110, 2025-01-16, usuario2"} className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-emerald-500/50 font-mono resize-none" />
              <div className="flex gap-2 justify-end">
                <button onClick={() => setShowBulk(false)} className="px-4 py-2 text-xs text-white/40 border border-white/10 rounded-lg hover:bg-white/5 transition">Cancelar</button>
                <button onClick={addBulk} className="px-4 py-2 bg-emerald-500 text-black font-bold text-xs rounded-lg hover:bg-emerald-400 transition">Importar</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Table */}
        {filtered.length === 0 ? (
          <div className="text-center py-10 border border-dashed border-white/5 rounded-2xl">
            <BarChart2 className="w-8 h-8 text-white/5 mx-auto mb-2" />
            <p className="text-[11px] text-white/20">No hay ventas en este periodo</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[580px] text-xs">
              <thead>
                <tr className="border-b border-white/5">
                  {['Modelo', 'Compra', 'Venta', 'Beneficio', 'Fecha', 'Cuenta', ''].map(h => (
                    <th key={h} className="text-left text-[9px] uppercase tracking-widest text-white/30 pb-2 pr-4">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filtered.map(s => {
                  const profit = Number(s.sell_price) - Number(s.buy_price);
                  return (
                    <tr key={s.id} className="hover:bg-white/5 transition-colors group">
                      <td className="py-2.5 pr-4 font-medium text-white">{s.model}</td>
                      <td className="py-2.5 pr-4 text-red-400">{fmt(Number(s.buy_price))}</td>
                      <td className="py-2.5 pr-4 text-blue-400">{fmt(Number(s.sell_price))}</td>
                      <td className={`py-2.5 pr-4 font-bold ${profit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(profit)}</td>
                      <td className="py-2.5 pr-4 text-white/40">{s.date}</td>
                      <td className="py-2.5 pr-4 text-white/40">{s.vinted_account ? `@${s.vinted_account}` : '-'}</td>
                      <td className="py-2.5">
                        <button onClick={() => deleteSale(s.id)} className="opacity-0 group-hover:opacity-100 text-white/20 hover:text-red-400 transition">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-white/10">
                  <td className="py-3 font-bold text-white text-[10px] uppercase tracking-widest">Total</td>
                  <td className="py-3 font-bold text-red-400">{fmt(stats.costs)}</td>
                  <td className="py-3 font-bold text-blue-400">{fmt(stats.revenue)}</td>
                  <td className="py-3 font-bold text-emerald-400">{fmt(stats.profit)}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
