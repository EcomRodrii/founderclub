import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  TrendingUp, BarChart2,
  Plus, Trash2, Download, Upload, X, User, FileText,
  Sparkles, Zap, Loader, ShoppingCart, Package, RotateCcw, Undo2
} from 'lucide-react';
import * as XLSX from 'xlsx';

type Period = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'biannual' | 'total';

interface Sale {
  id: number;
  model: string;
  buy_price: number;        // legacy / opcional
  sell_price: number;
  date: string;
  vinted_account: string | null;
  boost_cost?: number | null;
  refunded?: boolean;
  refunded_at?: string | null;
}

interface Purchase {
  id: number;
  supplier: string | null;
  total_amount: number;
  units: number;
  date: string;
  invoice_filename: string | null;
  notes: string | null;
}

interface Account { id: number; username: string; }

const PERIODS: { key: Period; label: string }[] = [
  { key: 'daily', label: 'Hoy' },
  { key: 'weekly', label: 'Semana' },
  { key: 'monthly', label: 'Mes' },
  { key: 'quarterly', label: 'Trimestre' },
  { key: 'biannual', label: 'Semestre' },
  { key: 'total', label: 'Total' },
];

function filterByDate<T extends { date: string }>(items: T[], period: Period): T[] {
  if (period === 'total') return items;
  const now = new Date();
  const from = new Date();
  if (period === 'daily') from.setHours(0, 0, 0, 0);
  else if (period === 'weekly') from.setDate(now.getDate() - 7);
  else if (period === 'monthly') from.setMonth(now.getMonth() - 1);
  else if (period === 'quarterly') from.setMonth(now.getMonth() - 3);
  else if (period === 'biannual') from.setMonth(now.getMonth() - 6);
  return items.filter(s => new Date(s.date) >= from);
}

function calcStats(sales: Sale[], purchases: Purchase[]) {
  // Las ventas reembolsadas NO cuentan como facturación
  const activeSales = sales.filter(s => !s.refunded);
  const refundedSales = sales.filter(s => s.refunded);
  const revenue = activeSales.reduce((a, s) => a + Number(s.sell_price), 0);
  const refundedAmount = refundedSales.reduce((a, s) => a + Number(s.sell_price), 0);
  const purchaseTotal = purchases.reduce((a, p) => a + Number(p.total_amount), 0);
  const manualBuyTotal = sales.reduce((a, s) => a + Number(s.buy_price || 0), 0);
  const totalBought = purchaseTotal + manualBuyTotal;
  // Boost se paga incluso si la venta acaba reembolsada → siempre cuenta
  const boostCosts = sales.reduce((a, s) => a + Number(s.boost_cost || 0), 0);
  const net = revenue - totalBought - boostCosts;
  const unitsBought = purchases.reduce((a, p) => a + Number(p.units || 0), 0);
  const unitsSold = activeSales.length;
  const unitsRefunded = refundedSales.length;
  return { revenue, refundedAmount, purchaseTotal, manualBuyTotal, totalBought, boostCosts, net, unitsBought, unitsSold, unitsRefunded };
}

const fmt = (n: number) => n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

interface SaleForm {
  model: string;
  sell_price: string;
  boost_cost: string;
  date: string;
  vinted_account: string;
}

interface PurchaseForm {
  supplier: string;
  total_amount: string;
  units: string;
  date: string;
  invoice_filename: string;
  notes: string;
}

const EMPTY_SALE: SaleForm = {
  model: '', sell_price: '', boost_cost: '',
  date: new Date().toISOString().split('T')[0], vinted_account: '',
};

const EMPTY_PURCHASE: PurchaseForm = {
  supplier: '', total_amount: '', units: '',
  date: new Date().toISOString().split('T')[0], invoice_filename: '', notes: '',
};

export default function ProfitControl({ token }: { token: string }) {
  const [period, setPeriod] = useState<Period>('monthly');
  const [sales, setSales] = useState<Sale[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

  const [showAddSale, setShowAddSale] = useState(false);
  const [showAddPurchase, setShowAddPurchase] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [newAccount, setNewAccount] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrMsg, setOcrMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [draggingPdf, setDraggingPdf] = useState(false);

  const xlsxRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  const [saleForm, setSaleForm] = useState<SaleForm>(EMPTY_SALE);
  const [purchaseForm, setPurchaseForm] = useState<PurchaseForm>(EMPTY_PURCHASE);

  const authFetch = (url: string, opts: RequestInit = {}) =>
    fetch(url, { ...opts, headers: { ...(opts.headers as any), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

  const load = async () => {
    const [s, p, a] = await Promise.all([
      authFetch('/api/profits/sales').then(r => r.json()),
      authFetch('/api/profits/purchases').then(r => r.json()).catch(() => []),
      authFetch('/api/profits/accounts').then(r => r.json()),
    ]);
    setSales(Array.isArray(s) ? s : []);
    setPurchases(Array.isArray(p) ? p : []);
    setAccounts(Array.isArray(a) ? a : []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const filteredSales = filterByDate(sales, period);
  const filteredPurchases = filterByDate(purchases, period);
  const stats = calcStats(filteredSales, filteredPurchases);

  // ── Sales actions ──────────────────────────────────────────────────
  const addSale = async () => {
    if (!saleForm.model || !saleForm.sell_price || !saleForm.date) return;
    await authFetch('/api/profits/sales', {
      method: 'POST',
      body: JSON.stringify({
        model: saleForm.model,
        buy_price: 0,
        sell_price: parseFloat(saleForm.sell_price) || 0,
        boost_cost: parseFloat(saleForm.boost_cost) || 0,
        date: saleForm.date,
        vinted_account: saleForm.vinted_account || null,
      }),
    });
    setSaleForm(EMPTY_SALE);
    setShowAddSale(false);
    load();
  };
  const deleteSale = async (id: number) => {
    await authFetch(`/api/profits/sales/${id}`, { method: 'DELETE' });
    load();
  };
  const toggleRefund = async (sale: Sale) => {
    await authFetch(`/api/profits/sales/${sale.id}/refund`, {
      method: 'PATCH',
      body: JSON.stringify({ refunded: !sale.refunded }),
    });
    load();
  };

  // ── Purchases actions ──────────────────────────────────────────────
  const addPurchase = async () => {
    if (!purchaseForm.total_amount || !purchaseForm.date) return;
    await authFetch('/api/profits/purchases', {
      method: 'POST',
      body: JSON.stringify({
        supplier: purchaseForm.supplier || null,
        total_amount: parseFloat(purchaseForm.total_amount) || 0,
        units: parseInt(purchaseForm.units) || 1,
        date: purchaseForm.date,
        invoice_filename: purchaseForm.invoice_filename || null,
        notes: purchaseForm.notes || null,
      }),
    });
    setPurchaseForm(EMPTY_PURCHASE);
    setOcrMsg(null);
    setShowAddPurchase(false);
    load();
  };
  const deletePurchase = async (id: number) => {
    await authFetch(`/api/profits/purchases/${id}`, { method: 'DELETE' });
    load();
  };

  // ── Accounts ───────────────────────────────────────────────────────
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

  // ── Bulk + Excel import (solo ventas) ──────────────────────────────
  const addBulk = async () => {
    const rows = bulkText.trim().split('\n').map(line => {
      const parts = line.split(/[\t;,]/).map(p => p.trim());
      if (parts.length < 3) return null;
      return { model: parts[0], sell_price: parseFloat(parts[1]), buy_price: 0, date: parts[2], vinted_account: parts[3] || null };
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
        sell_price: parseFloat(r['Precio Venta'] || r['sell_price'] || 0),
        buy_price: parseFloat(r['Precio Compra'] || r['buy_price'] || 0) || 0,
        boost_cost: parseFloat(r['Destacado'] || r['boost_cost'] || 0) || 0,
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
    const ventas = filteredSales.map(s => {
      const sell = Number(s.sell_price);
      const boost = Number(s.boost_cost || 0);
      const isRef = !!s.refunded;
      return {
        'Modelo': s.model,
        'Ingreso': isRef ? 0 : sell,
        'Destacado': boost,
        'Margen': isRef ? -boost : sell - boost,
        'Estado': isRef ? 'Reembolsada' : 'OK',
        'Fecha': s.date,
        'Cuenta': s.vinted_account || '',
      };
    });
    const compras = filteredPurchases.map(p => ({
      'Proveedor': p.supplier || '',
      'Total €': Number(p.total_amount),
      'Unidades': p.units,
      'Coste medio/ud': p.units ? Number(p.total_amount) / Number(p.units) : 0,
      'Fecha': p.date,
      'Factura': p.invoice_filename || '',
      'Notas': p.notes || '',
    }));
    const resumen = [
      { Concepto: 'Facturación (ventas activas)', Importe: stats.revenue },
      { Concepto: 'Compras (facturas)', Importe: stats.purchaseTotal },
      { Concepto: 'Compras manuales', Importe: stats.manualBuyTotal },
      { Concepto: 'Destacados', Importe: stats.boostCosts },
      { Concepto: 'Reembolsos (excluidos)', Importe: stats.refundedAmount },
      { Concepto: 'BENEFICIO NETO', Importe: stats.net },
      { Concepto: 'Unidades compradas', Importe: stats.unitsBought },
      { Concepto: 'Unidades vendidas', Importe: stats.unitsSold },
      { Concepto: 'Unidades reembolsadas', Importe: stats.unitsRefunded },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumen), 'Resumen');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ventas), 'Ventas');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(compras), 'Compras');
    XLSX.writeFile(wb, `founderclub-${period}-${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  // ── OCR de factura PDF ─────────────────────────────────────────────
  const handlePdf = async (file: File) => {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setOcrMsg({ kind: 'err', text: 'Solo PDFs.' });
      return;
    }
    if (file.size > 13 * 1024 * 1024) {
      setOcrMsg({ kind: 'err', text: 'PDF demasiado grande (máx 13 MB).' });
      return;
    }
    setOcrLoading(true);
    setOcrMsg(null);
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const res = await authFetch('/api/profits/ocr-invoice', {
        method: 'POST',
        body: JSON.stringify({ pdfBase64: b64, filename: file.name }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error OCR');
      // Pre-rellena el form de COMPRA y lo abre
      setPurchaseForm(f => ({
        ...f,
        supplier: data.supplier || f.supplier,
        total_amount: data.total_amount != null ? String(data.total_amount) : f.total_amount,
        units: data.units != null ? String(data.units) : f.units,
        date: data.date || f.date,
        invoice_filename: file.name,
        notes: data.raw_summary || f.notes,
      }));
      setOcrMsg({ kind: 'ok', text: `Factura procesada: ${data.units || '?'} ud · ${data.total_amount ?? '?'}€ · ${data.supplier || 'sin proveedor'}` });
      setShowAddPurchase(true);
    } catch (err: any) {
      setOcrMsg({ kind: 'err', text: 'OCR falló: ' + (err.message || err) });
    } finally {
      setOcrLoading(false);
    }
  };

  const onPdfDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDraggingPdf(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handlePdf(file);
  };

  const accountStats = (username: string) => {
    const acSales = sales.filter(s => s.vinted_account === username);
    const acStats = calcStats(acSales, []);
    return { count: acSales.length, revenue: acStats.revenue };
  };

  const statCards = [
    { label: 'Facturación', value: stats.revenue, sub: `${stats.unitsSold} ventas`, icon: <BarChart2 className="w-5 h-5" />, color: 'text-blue-300', bg: 'bg-blue-500/10 border-blue-500/30' },
    { label: 'Compras', value: stats.totalBought, sub: `${stats.unitsBought} ud compradas`, icon: <ShoppingCart className="w-5 h-5" />, color: 'text-red-300', bg: 'bg-red-500/10 border-red-500/30' },
    { label: 'Destacados', value: stats.boostCosts, sub: 'gastos boost', icon: <Zap className="w-5 h-5" />, color: 'text-amber-300', bg: 'bg-amber-500/10 border-amber-500/30' },
    { label: 'Reembolsos', value: stats.refundedAmount, sub: `${stats.unitsRefunded} venta${stats.unitsRefunded === 1 ? '' : 's'} devuelta${stats.unitsRefunded === 1 ? '' : 's'}`, icon: <RotateCcw className="w-5 h-5" />, color: 'text-fuchsia-300', bg: 'bg-fuchsia-500/10 border-fuchsia-500/30' },
    { label: 'Beneficio Neto', value: stats.net, sub: 'dinero limpio', icon: <TrendingUp className="w-5 h-5" />, color: 'text-acid', bg: 'bg-acid-soft border-acid' },
  ];

  if (loading) return <div className="flex items-center justify-center py-20"><div className="w-8 h-8 border-2 border-acid border-t-transparent rounded-full animate-spin" /></div>;

  return (
    <div className="space-y-6 pb-24 lg:pb-6">

      {/* Period selector */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {PERIODS.map(p => (
          <button key={p.key} onClick={() => setPeriod(p.key)}
            className={`px-4 py-2 rounded-full text-xs font-bold uppercase tracking-[0.14em] whitespace-nowrap transition ease-hub border ${period === p.key ? 'bg-acid-soft border-acid text-acid' : 'bg-white/[0.03] border-white/10 text-muted-strong hover:border-acid hover:text-acid'}`}>
            {p.label}
          </button>
        ))}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {statCards.map(c => (
          <div key={c.label} className={`rounded-2xl border p-4 ${c.bg}`}>
            <div className={`flex items-center gap-2 mb-2 ${c.color}`}>{c.icon}<span className="text-[10px] uppercase tracking-widest font-bold">{c.label}</span></div>
            <p className={`text-lg font-bold ${c.color}`}>{fmt(c.value)}</p>
            <p className="text-[10px] text-white/30 mt-1">{c.sub}</p>
          </div>
        ))}
      </div>

      {/* PDF OCR drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDraggingPdf(true); }}
        onDragLeave={() => setDraggingPdf(false)}
        onDrop={onPdfDrop}
        onClick={() => pdfRef.current?.click()}
        className={`relative border-2 border-dashed rounded-2xl px-6 py-5 text-center cursor-pointer transition ease-hub ${
          draggingPdf ? 'border-acid bg-acid-soft scale-[1.01]' : 'border-white/10 hover:border-acid hover:bg-white/[0.02]'
        }`}
      >
        <input ref={pdfRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePdf(f); e.target.value = ''; }} />
        <div className="flex items-center justify-center gap-4">
          {ocrLoading ? (
            <Loader className="w-6 h-6 text-acid animate-spin" />
          ) : (
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-white/[0.04] border border-white/10">
              <FileText className="w-5 h-5 text-acid" />
            </div>
          )}
          <div className="text-left">
            <p className="text-sm font-bold text-white flex items-center gap-2">
              {ocrLoading ? 'Procesando factura con IA…' : 'Arrastra una factura PDF de COMPRA aquí'}
              {!ocrLoading && <Sparkles className="w-3.5 h-3.5 text-acid" />}
            </p>
            <p className="text-[11px] text-muted">El OCR detectará proveedor, total €, unidades del lote y fecha automáticamente.</p>
          </div>
        </div>
        {ocrMsg && (
          <p className={`mt-3 text-[11px] ${ocrMsg.kind === 'ok' ? 'text-acid' : 'text-red-400'}`}>{ocrMsg.text}</p>
        )}
      </div>

      {/* COMPRAS */}
      <div className="bg-panel border border-white/[0.08] rounded-3xl p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h3 className="text-xs uppercase tracking-[0.2em] font-bold text-muted-strong flex items-center gap-2"><ShoppingCart className="w-4 h-4" />Compras ({filteredPurchases.length} facturas)</h3>
          <button onClick={() => setShowAddPurchase(true)} className="flex items-center gap-1 text-xs bg-acid-gradient text-black font-bold px-4 py-1.5 rounded-full shadow-acid hover:-translate-y-0.5 transition ease-hub">
            <Plus className="w-3.5 h-3.5" /> Añadir factura
          </button>
        </div>

        <AnimatePresence>
          {showAddPurchase && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
              className="mb-4 bg-white/[0.03] border border-white/[0.08] rounded-2xl p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="col-span-2">
                <label className="text-[9px] uppercase tracking-[0.18em] text-muted-strong font-bold block mb-1">Proveedor</label>
                <input value={purchaseForm.supplier} onChange={e => setPurchaseForm({ ...purchaseForm, supplier: e.target.value })} placeholder="Adidas Outlet, mayorista, StockX…" className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-acid" />
              </div>
              <div>
                <label className="text-[9px] uppercase tracking-[0.18em] text-muted-strong font-bold block mb-1">Total €</label>
                <input type="number" step="0.01" value={purchaseForm.total_amount} onChange={e => setPurchaseForm({ ...purchaseForm, total_amount: e.target.value })} placeholder="5000.00" className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-acid" />
              </div>
              <div>
                <label className="text-[9px] uppercase tracking-[0.18em] text-muted-strong font-bold block mb-1">Unidades</label>
                <input type="number" value={purchaseForm.units} onChange={e => setPurchaseForm({ ...purchaseForm, units: e.target.value })} placeholder="25" className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-acid" />
              </div>
              <div>
                <label className="text-[9px] uppercase tracking-[0.18em] text-muted-strong font-bold block mb-1">Fecha</label>
                <input type="date" value={purchaseForm.date} onChange={e => setPurchaseForm({ ...purchaseForm, date: e.target.value })} className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-acid" />
              </div>
              <div className="col-span-2 sm:col-span-3">
                <label className="text-[9px] uppercase tracking-[0.18em] text-muted-strong font-bold block mb-1">Notas (opcional)</label>
                <input value={purchaseForm.notes} onChange={e => setPurchaseForm({ ...purchaseForm, notes: e.target.value })} placeholder="Tipo de producto, lote…" className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-acid" />
              </div>
              {purchaseForm.invoice_filename && (
                <div className="col-span-2 sm:col-span-4 flex items-center gap-2 text-[10px] text-acid bg-acid-soft border border-acid rounded-xl px-3 py-2">
                  <FileText className="w-3.5 h-3.5" />
                  <span>Factura: <span className="font-mono">{purchaseForm.invoice_filename}</span></span>
                </div>
              )}
              <div className="col-span-2 sm:col-span-4 flex gap-2 justify-end">
                <button onClick={() => { setShowAddPurchase(false); setOcrMsg(null); setPurchaseForm(EMPTY_PURCHASE); }} className="px-4 py-2 text-xs text-muted border border-white/10 rounded-full hover:bg-white/5 transition">Cancelar</button>
                <button onClick={addPurchase} className="px-4 py-2 bg-acid-gradient text-black font-bold text-xs rounded-full shadow-acid hover:-translate-y-0.5 transition ease-hub">Guardar compra</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {filteredPurchases.length === 0 ? (
          <div className="text-center py-10 border border-dashed border-white/5 rounded-2xl">
            <Package className="w-8 h-8 text-white/5 mx-auto mb-2" />
            <p className="text-[11px] text-white/20">No hay facturas de compra en este periodo</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-xs">
              <thead>
                <tr className="border-b border-white/5">
                  {['Proveedor', 'Total', 'Unidades', '€/ud', 'Fecha', 'Factura', ''].map(h => (
                    <th key={h} className="text-left text-[9px] uppercase tracking-widest text-muted pb-2 pr-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filteredPurchases.map(p => {
                  const total = Number(p.total_amount);
                  const ppu = p.units > 0 ? total / Number(p.units) : 0;
                  return (
                    <tr key={p.id} className="hover:bg-white/[0.03] transition-colors group">
                      <td className="py-2.5 pr-3 font-medium text-white">{p.supplier || '-'}</td>
                      <td className="py-2.5 pr-3 text-red-300 font-bold">{fmt(total)}</td>
                      <td className="py-2.5 pr-3 text-white/70">{p.units}</td>
                      <td className="py-2.5 pr-3 text-muted">{ppu > 0 ? fmt(ppu) : '-'}</td>
                      <td className="py-2.5 pr-3 text-muted">{p.date}</td>
                      <td className="py-2.5 pr-3 text-acid">{p.invoice_filename ? <span className="inline-flex items-center gap-1"><FileText className="w-3 h-3" />{p.invoice_filename}</span> : '-'}</td>
                      <td className="py-2.5">
                        <button onClick={() => deletePurchase(p.id)} className="opacity-0 group-hover:opacity-100 text-white/20 hover:text-red-400 transition">
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
                  <td className="py-3 font-bold text-red-300">{fmt(stats.purchaseTotal)}</td>
                  <td className="py-3 font-bold text-white/70">{stats.unitsBought}</td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* CUENTAS */}
      <div className="bg-panel border border-white/[0.08] rounded-3xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xs uppercase tracking-[0.2em] font-bold text-muted-strong flex items-center gap-2"><User className="w-4 h-4" />Cuentas Vinted</h3>
          <button onClick={() => setShowAddAccount(true)} className="flex items-center gap-1 text-xs text-acid hover:opacity-80 transition">
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
                <div key={a.id} className="bg-white/[0.03] border border-white/[0.08] rounded-2xl p-4 flex items-start justify-between">
                  <div>
                    <p className="font-bold text-sm text-white">@{a.username}</p>
                    <p className="text-[10px] text-muted mt-1">{ast.count} ventas · {fmt(ast.revenue)} facturado</p>
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
                placeholder="@usuario" className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:border-acid outline-none" autoFocus />
              <button onClick={addAccount} className="px-4 py-2 bg-acid-gradient text-black font-bold rounded-full text-sm shadow-acid hover:-translate-y-0.5 transition ease-hub">OK</button>
              <button onClick={() => setShowAddAccount(false)} className="px-3 py-2 bg-white/5 text-muted rounded-full hover:bg-white/10 transition"><X className="w-4 h-4" /></button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* VENTAS */}
      <div className="bg-panel border border-white/[0.08] rounded-3xl p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h3 className="text-xs uppercase tracking-[0.2em] font-bold text-muted-strong flex items-center gap-2"><BarChart2 className="w-4 h-4" />Ventas ({filteredSales.length})</h3>
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => setShowBulk(true)} className="flex items-center gap-1 text-xs text-muted hover:text-acid transition border border-white/10 px-3 py-1.5 rounded-full hover:border-acid">
              <Plus className="w-3.5 h-3.5" /> Masivo
            </button>
            <button onClick={() => xlsxRef.current?.click()} className="flex items-center gap-1 text-xs text-muted hover:text-acid transition border border-white/10 px-3 py-1.5 rounded-full hover:border-acid">
              <Upload className="w-3.5 h-3.5" /> Excel
            </button>
            <input ref={xlsxRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={importExcel} />
            <button onClick={exportExcel} className="flex items-center gap-1 text-xs text-acid hover:opacity-80 transition border border-acid px-3 py-1.5 rounded-full">
              <Download className="w-3.5 h-3.5" /> Exportar
            </button>
            <button onClick={() => setShowAddSale(true)} className="flex items-center gap-1 text-xs bg-acid-gradient text-black font-bold px-4 py-1.5 rounded-full shadow-acid hover:-translate-y-0.5 transition ease-hub">
              <Plus className="w-3.5 h-3.5" /> Añadir
            </button>
          </div>
        </div>

        <AnimatePresence>
          {showAddSale && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
              className="mb-4 bg-white/[0.03] border border-white/[0.08] rounded-2xl p-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="col-span-2 sm:col-span-3">
                <label className="text-[9px] uppercase tracking-[0.18em] text-muted-strong font-bold block mb-1">Modelo</label>
                <input value={saleForm.model} onChange={e => setSaleForm({ ...saleForm, model: e.target.value })} placeholder="Adidas Samba OG White Black" className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-acid" />
              </div>
              <div>
                <label className="text-[9px] uppercase tracking-[0.18em] text-blue-300/80 font-bold block mb-1">Precio Venta €</label>
                <input type="number" step="0.01" value={saleForm.sell_price} onChange={e => setSaleForm({ ...saleForm, sell_price: e.target.value })} placeholder="0.00" className="w-full bg-black/40 border border-blue-500/30 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-blue-400" />
              </div>
              <div>
                <label className="text-[9px] uppercase tracking-[0.18em] text-amber-300/80 font-bold block mb-1">Destacado €</label>
                <input type="number" step="0.01" value={saleForm.boost_cost} onChange={e => setSaleForm({ ...saleForm, boost_cost: e.target.value })} placeholder="0.00" className="w-full bg-black/40 border border-amber-500/30 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-amber-400" />
              </div>
              <div>
                <label className="text-[9px] uppercase tracking-[0.18em] text-muted-strong font-bold block mb-1">Fecha</label>
                <input type="date" value={saleForm.date} onChange={e => setSaleForm({ ...saleForm, date: e.target.value })} className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-acid" />
              </div>
              <div className="col-span-2 sm:col-span-3">
                <label className="text-[9px] uppercase tracking-[0.18em] text-muted-strong font-bold block mb-1">Cuenta Vinted</label>
                <select value={saleForm.vinted_account} onChange={e => setSaleForm({ ...saleForm, vinted_account: e.target.value })} className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-acid">
                  <option value="">Sin cuenta</option>
                  {accounts.map(a => <option key={a.id} value={a.username}>@{a.username}</option>)}
                </select>
              </div>
              <div className="col-span-2 sm:col-span-3 flex gap-2 justify-end">
                <button onClick={() => { setShowAddSale(false); setSaleForm(EMPTY_SALE); }} className="px-4 py-2 text-xs text-muted border border-white/10 rounded-full hover:bg-white/5 transition">Cancelar</button>
                <button onClick={addSale} className="px-4 py-2 bg-acid-gradient text-black font-bold text-xs rounded-full shadow-acid hover:-translate-y-0.5 transition ease-hub">Guardar venta</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showBulk && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-4 bg-white/[0.03] border border-white/[0.08] rounded-2xl p-4 space-y-3">
              <p className="text-[10px] text-muted">Una línea por venta:<br />
                <span className="text-white/60 font-mono">Modelo, Precio venta, Fecha (YYYY-MM-DD), @cuenta</span>
              </p>
              <textarea value={bulkText} onChange={e => setBulkText(e.target.value)} rows={5} placeholder={"Adidas Samba, 95, 2025-01-15, usuario1\nNike Dunk, 110, 2025-01-16, usuario2"} className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-acid font-mono resize-none" />
              <div className="flex gap-2 justify-end">
                <button onClick={() => setShowBulk(false)} className="px-4 py-2 text-xs text-muted border border-white/10 rounded-full hover:bg-white/5 transition">Cancelar</button>
                <button onClick={addBulk} className="px-4 py-2 bg-acid-gradient text-black font-bold text-xs rounded-full shadow-acid hover:-translate-y-0.5 transition ease-hub">Importar</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {filteredSales.length === 0 ? (
          <div className="text-center py-10 border border-dashed border-white/5 rounded-2xl">
            <BarChart2 className="w-8 h-8 text-white/5 mx-auto mb-2" />
            <p className="text-[11px] text-white/20">No hay ventas en este periodo</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-xs">
              <thead>
                <tr className="border-b border-white/5">
                  {['Modelo', 'Ingreso', 'Destacado', 'Margen', 'Fecha', 'Cuenta', 'Estado', ''].map(h => (
                    <th key={h} className="text-left text-[9px] uppercase tracking-widest text-muted pb-2 pr-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filteredSales.map(s => {
                  const sell = Number(s.sell_price);
                  const boost = Number(s.boost_cost || 0);
                  const margin = sell - boost;
                  const isRef = !!s.refunded;
                  return (
                    <tr key={s.id} className={`hover:bg-white/[0.03] transition-colors group ${isRef ? 'opacity-50' : ''}`}>
                      <td className={`py-2.5 pr-3 font-medium ${isRef ? 'text-muted line-through' : 'text-white'}`}>{s.model}</td>
                      <td className={`py-2.5 pr-3 font-bold ${isRef ? 'text-muted line-through' : 'text-blue-300'}`}>{fmt(sell)}</td>
                      <td className="py-2.5 pr-3 text-amber-300">{boost > 0 ? fmt(boost) : '-'}</td>
                      <td className={`py-2.5 pr-3 font-bold ${isRef ? 'text-fuchsia-400' : margin >= 0 ? 'text-acid' : 'text-red-400'}`}>{isRef ? '−' + fmt(boost) : fmt(margin)}</td>
                      <td className="py-2.5 pr-3 text-muted">{s.date}</td>
                      <td className="py-2.5 pr-3 text-muted">{s.vinted_account ? `@${s.vinted_account}` : '-'}</td>
                      <td className="py-2.5 pr-3">
                        {isRef ? (
                          <span className="inline-flex items-center gap-1 text-[9px] uppercase tracking-wider font-bold bg-fuchsia-500/15 border border-fuchsia-500/40 text-fuchsia-300 rounded-full px-2 py-0.5">
                            <RotateCcw className="w-3 h-3" /> Reembolsada
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[9px] uppercase tracking-wider font-bold bg-acid-soft border border-acid text-acid rounded-full px-2 py-0.5">
                            ✓ OK
                          </span>
                        )}
                      </td>
                      <td className="py-2.5">
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                          <button
                            onClick={() => toggleRefund(s)}
                            title={isRef ? 'Deshacer reembolso' : 'Marcar reembolsada'}
                            className={`p-1.5 rounded-lg border transition ${
                              isRef
                                ? 'text-acid border-acid hover:bg-acid-soft'
                                : 'text-fuchsia-400 border-fuchsia-500/30 hover:bg-fuchsia-500/15'
                            }`}
                          >
                            {isRef ? <Undo2 className="w-3.5 h-3.5" /> : <RotateCcw className="w-3.5 h-3.5" />}
                          </button>
                          <button onClick={() => deleteSale(s.id)} className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition" title="Eliminar venta">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-white/10">
                  <td className="py-3 font-bold text-white text-[10px] uppercase tracking-widest">Activas ({stats.unitsSold})</td>
                  <td className="py-3 font-bold text-blue-300">{fmt(stats.revenue)}</td>
                  <td className="py-3 font-bold text-amber-300">{fmt(stats.boostCosts)}</td>
                  <td className="py-3 font-bold text-acid">{fmt(stats.revenue - stats.boostCosts)}</td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            </table>
            <p className="text-[10px] text-muted mt-3">
              <span className="text-acid font-bold">Beneficio Neto real ({fmt(stats.net)}):</span>{' '}
              ventas {fmt(stats.revenue)} − compras {fmt(stats.totalBought)} − destacados {fmt(stats.boostCosts)}
              {stats.unitsRefunded > 0 && <span className="text-fuchsia-300"> · {stats.unitsRefunded} venta{stats.unitsRefunded === 1 ? '' : 's'} reembolsada{stats.unitsRefunded === 1 ? '' : 's'} ({fmt(stats.refundedAmount)}) excluidas</span>}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
