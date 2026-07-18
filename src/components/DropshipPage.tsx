import React, { useState, useEffect, useCallback } from 'react';
import {
  Plus, Trash2, Edit2, Check, X, RefreshCcw, ShoppingCart,
  Package, Truck, CheckCircle2, Send, AlertCircle, ChevronDown, ChevronRight,
  ExternalLink, Copy,
} from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

type OrderStatus = 'pending_purchase' | 'purchased_temu' | 'in_transit' | 'received' | 'shipped';

interface Product {
  id: number;
  temu_url: string;
  temu_cost: number | null;
  vinted_price: number | null;
  title: string;
  stock: number;
  notes: string | null;
  is_active: boolean;
}

interface Order {
  id: number;
  product_id: number | null;
  product_title: string | null;
  temu_url: string | null;
  vinted_order_id: string;
  buyer_name: string | null;
  vinted_item_title: string | null;
  vinted_amount: number | null;
  temu_order_id: string | null;
  status: OrderStatus;
  created_at: string;
}

interface VintedAccount {
  id: number;
  username: string;
  domain: string;
}

// ── Kanban config ─────────────────────────────────────────────────────────────

const COLUMNS: { status: OrderStatus; label: string; icon: React.ReactNode; color: string }[] = [
  { status: 'pending_purchase', label: 'Pendiente de pedir', icon: <ShoppingCart className="w-3.5 h-3.5" />, color: 'text-amber-400' },
  { status: 'purchased_temu',  label: 'En camino (Temu)',   icon: <Truck className="w-3.5 h-3.5" />,        color: 'text-blue-400' },
  { status: 'in_transit',      label: 'En tránsito',         icon: <Package className="w-3.5 h-3.5" />,      color: 'text-violet-400' },
  { status: 'received',        label: 'Listo para enviar',   icon: <CheckCircle2 className="w-3.5 h-3.5" />, color: 'text-green-400' },
  { status: 'shipped',         label: 'Enviado',              icon: <Send className="w-3.5 h-3.5" />,         color: 'text-zinc-400' },
];

const STATUS_NEXT: Record<OrderStatus, OrderStatus | null> = {
  pending_purchase: 'purchased_temu',
  purchased_temu:  'in_transit',
  in_transit:      'received',
  received:        'shipped',
  shipped:         null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function api(token: string, path: string, opts?: RequestInit) {
  return fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts?.headers || {}) } });
}

// ── Product form modal ────────────────────────────────────────────────────────

function ProductModal({ token, product, onClose, onSaved }: {
  token: string;
  product: Product | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    title: product?.title || '',
    temu_url: product?.temu_url || '',
    temu_cost: product?.temu_cost?.toString() || '',
    vinted_price: product?.vinted_price?.toString() || '',
    stock: product?.stock?.toString() || '1',
    notes: product?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    if (!form.title || !form.temu_url) { setErr('Título y URL de Temu son obligatorios'); return; }
    setSaving(true); setErr('');
    const body = {
      title: form.title,
      temu_url: form.temu_url,
      temu_cost: form.temu_cost ? parseFloat(form.temu_cost) : null,
      vinted_price: form.vinted_price ? parseFloat(form.vinted_price) : null,
      stock: parseInt(form.stock) || 1,
      notes: form.notes || null,
    };
    const r = product
      ? await api(token, `/api/dropship/products/${product.id}`, { method: 'PUT', body: JSON.stringify(body) })
      : await api(token, '/api/dropship/products', { method: 'POST', body: JSON.stringify(body) });
    if (r.ok) { onSaved(); onClose(); }
    else { const d = await r.json(); setErr(d.error || 'Error al guardar'); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-[#1a1a1a] border border-white/[0.08] rounded-2xl p-6 w-full max-w-md space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-[#f2f2ef]">{product ? 'Editar producto' : 'Nuevo producto'}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-4 h-4" /></button>
        </div>
        {[
          { key: 'title', label: 'Nombre del producto', placeholder: 'Nike Air Max 97 — blanco 42' },
          { key: 'temu_url', label: 'URL de Temu', placeholder: 'https://www.temu.com/...' },
          { key: 'temu_cost', label: 'Coste Temu (€)', placeholder: '12.50' },
          { key: 'vinted_price', label: 'Precio Vinted (€)', placeholder: '45.00' },
          { key: 'stock', label: 'Stock', placeholder: '1' },
          { key: 'notes', label: 'Notas (opcional)', placeholder: 'Variante: talla 42, color blanco…' },
        ].map(({ key, label, placeholder }) => (
          <div key={key}>
            <label className="block text-xs font-medium text-[#888880] mb-1">{label}</label>
            <input
              value={(form as any)[key]}
              onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
              placeholder={placeholder}
              className="w-full bg-white/[0.04] border border-white/[0.07] rounded-xl px-3 py-2 text-sm text-[#f2f2ef] placeholder-[#444] focus:outline-none focus:border-[#d4ff00]/40 transition"
            />
          </div>
        ))}
        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-2 rounded-xl border border-white/[0.08] text-xs text-[#888880] hover:text-[#f2f2ef] transition">Cancelar</button>
          <button onClick={save} disabled={saving} className="flex-1 py-2 rounded-xl bg-[#d4ff00] text-black text-xs font-bold hover:bg-[#c8f000] disabled:opacity-40 transition">
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Manual order modal ────────────────────────────────────────────────────────

function ManualOrderModal({ token, products, onClose, onSaved }: {
  token: string;
  products: Product[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({ vinted_order_id: '', buyer_name: '', buyer_address: '', vinted_item_title: '', vinted_amount: '', product_id: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    if (!form.vinted_order_id) { setErr('ID del pedido Vinted requerido'); return; }
    setSaving(true); setErr('');
    const r = await api(token, '/api/dropship/orders', {
      method: 'POST',
      body: JSON.stringify({
        vinted_order_id: form.vinted_order_id,
        buyer_name: form.buyer_name || null,
        buyer_address: form.buyer_address || null,
        vinted_item_title: form.vinted_item_title || null,
        vinted_amount: form.vinted_amount ? parseFloat(form.vinted_amount) : null,
        product_id: form.product_id ? parseInt(form.product_id) : null,
      }),
    });
    if (r.ok) { onSaved(); onClose(); }
    else { const d = await r.json(); setErr(d.error || 'Error'); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-[#1a1a1a] border border-white/[0.08] rounded-2xl p-6 w-full max-w-md space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-[#f2f2ef]">Añadir pedido manualmente</h3>
          <button onClick={onClose}><X className="w-4 h-4 text-zinc-500" /></button>
        </div>
        {[
          { key: 'vinted_order_id', label: 'ID pedido Vinted *', placeholder: '123456789' },
          { key: 'vinted_item_title', label: 'Artículo vendido', placeholder: 'Nike Air Max 97' },
          { key: 'vinted_amount', label: 'Importe (€)', placeholder: '45.00' },
          { key: 'buyer_name', label: 'Nombre comprador', placeholder: 'María García' },
          { key: 'buyer_address', label: 'Dirección entrega', placeholder: 'Calle Mayor 1, 28001 Madrid' },
        ].map(({ key, label, placeholder }) => (
          <div key={key}>
            <label className="block text-xs font-medium text-[#888880] mb-1">{label}</label>
            <input
              value={(form as any)[key]}
              onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
              placeholder={placeholder}
              className="w-full bg-white/[0.04] border border-white/[0.07] rounded-xl px-3 py-2 text-sm text-[#f2f2ef] placeholder-[#444] focus:outline-none focus:border-[#d4ff00]/40 transition"
            />
          </div>
        ))}
        <div>
          <label className="block text-xs font-medium text-[#888880] mb-1">Producto del catálogo (opcional)</label>
          <select
            value={form.product_id}
            onChange={e => setForm(f => ({ ...f, product_id: e.target.value }))}
            className="w-full bg-white/[0.04] border border-white/[0.07] rounded-xl px-3 py-2 text-sm text-[#f2f2ef] focus:outline-none"
          >
            <option value="">— Sin producto —</option>
            {products.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-2 rounded-xl border border-white/[0.08] text-xs text-[#888880]">Cancelar</button>
          <button onClick={save} disabled={saving} className="flex-1 py-2 rounded-xl bg-[#d4ff00] text-black text-xs font-bold disabled:opacity-40">
            {saving ? '…' : 'Añadir pedido'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Order card ────────────────────────────────────────────────────────────────

function OrderCard({ order, token, onRefresh }: { order: Order; token: string; onRefresh: () => void }) {
  const [moving, setMoving] = useState(false);
  const [buying, setBuying] = useState(false);
  const [editTemuId, setEditTemuId] = useState(false);
  const [temuId, setTemuId] = useState(order.temu_order_id || '');
  const col = COLUMNS.find(c => c.status === order.status)!;
  const nextStatus = STATUS_NEXT[order.status];

  const moveNext = async () => {
    if (!nextStatus) return;
    setMoving(true);
    await api(token, `/api/dropship/orders/${order.id}/status`, {
      method: 'PUT', body: JSON.stringify({ status: nextStatus }),
    });
    onRefresh();
    setMoving(false);
  };

  const triggerBuyTemu = async () => {
    if (!order.temu_url && !order.product_title) {
      alert('Este pedido no tiene producto de Temu asociado. Edítalo y asigna un producto.'); return;
    }
    setBuying(true);
    const r = await api(token, `/api/dropship/orders/${order.id}/buy-temu`, { method: 'POST' });
    const d = await r.json();
    if (r.ok) alert(`Temu: job encolado (${d.jobId}). El carrito se abrirá en segundo plano.`);
    else alert('Error: ' + (d.error || 'desconocido'));
    setBuying(false);
  };

  const saveTemuId = async () => {
    await api(token, `/api/dropship/orders/${order.id}/temu-order`, {
      method: 'PUT', body: JSON.stringify({ temu_order_id: temuId }),
    });
    setEditTemuId(false);
    onRefresh();
  };

  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 space-y-2 hover:border-white/[0.1] transition">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[#f2f2ef] truncate">{order.vinted_item_title || order.product_title || 'Pedido sin título'}</p>
          <p className="text-[10px] text-[#888880] mt-0.5">#{order.vinted_order_id}</p>
        </div>
        {order.vinted_amount && (
          <span className="shrink-0 text-xs font-bold text-[#d4ff00]">{Number(order.vinted_amount).toFixed(2)} €</span>
        )}
      </div>

      {order.buyer_name && (
        <p className="text-[10px] text-[#666660]">Comprador: {order.buyer_name}</p>
      )}

      {/* Temu order ID */}
      <div className="flex items-center gap-1.5">
        {editTemuId ? (
          <>
            <input
              value={temuId}
              onChange={e => setTemuId(e.target.value)}
              placeholder="ID pedido Temu"
              className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1 text-[10px] text-[#f2f2ef] focus:outline-none"
            />
            <button onClick={saveTemuId} className="text-green-400 p-1"><Check className="w-3 h-3" /></button>
            <button onClick={() => setEditTemuId(false)} className="text-zinc-500 p-1"><X className="w-3 h-3" /></button>
          </>
        ) : (
          <button
            onClick={() => setEditTemuId(true)}
            className="text-[10px] text-[#555550] hover:text-[#888880] transition flex items-center gap-1"
          >
            <Edit2 className="w-2.5 h-2.5" />
            {order.temu_order_id ? `Temu #${order.temu_order_id}` : 'Añadir ID Temu'}
          </button>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 pt-0.5">
        {order.status === 'pending_purchase' && (
          <button
            onClick={triggerBuyTemu}
            disabled={buying}
            className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg bg-blue-500/15 border border-blue-500/25 text-blue-400 text-[10px] font-semibold hover:bg-blue-500/25 disabled:opacity-40 transition"
          >
            {buying ? <RefreshCcw className="w-2.5 h-2.5 animate-spin" /> : <ShoppingCart className="w-2.5 h-2.5" />}
            Pedir en Temu
          </button>
        )}
        {order.temu_url && (
          <a href={order.temu_url} target="_blank" rel="noopener noreferrer"
            className="p-1.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-[#555550] hover:text-[#888880] transition">
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
        {nextStatus && (
          <button
            onClick={moveNext}
            disabled={moving}
            className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg bg-[#d4ff00]/10 border border-[#d4ff00]/20 text-[#d4ff00] text-[10px] font-semibold hover:bg-[#d4ff00]/20 disabled:opacity-40 transition"
          >
            {moving ? <RefreshCcw className="w-2.5 h-2.5 animate-spin" /> : <ChevronRight className="w-2.5 h-2.5" />}
            {COLUMNS.find(c => c.status === nextStatus)?.label.split(' ')[0]}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DropshipPage({ token }: { token: string }) {
  const [tab, setTab] = useState<'orders' | 'products'>('orders');
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [accounts, setAccounts] = useState<VintedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState<number | null>(null);
  const [productModal, setProductModal] = useState<Product | true | null>(null);
  const [orderModal, setOrderModal] = useState(false);

  const load = useCallback(async () => {
    const [pRes, oRes, aRes] = await Promise.all([
      api(token, '/api/dropship/products').then(r => r.json()),
      api(token, '/api/dropship/orders').then(r => r.json()),
      api(token, '/api/dropship/vinted-accounts').then(r => r.json()),
    ]);
    setProducts(Array.isArray(pRes) ? pRes : []);
    setOrders(Array.isArray(oRes) ? oRes : []);
    setAccounts(Array.isArray(aRes) ? aRes : []);
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const scanAccount = async (accId: number) => {
    setScanning(accId);
    const r = await api(token, `/api/dropship/scan/${accId}`, { method: 'POST' });
    const d = await r.json();
    if (r.ok) {
      if (d.new_orders > 0) alert(`✅ ${d.new_orders} pedido(s) nuevo(s) detectado(s)`);
      else alert('Sin pedidos nuevos');
      load();
    } else {
      alert('Error: ' + (d.error || 'desconocido'));
    }
    setScanning(null);
  };

  const deleteProduct = async (id: number) => {
    if (!confirm('¿Eliminar producto?')) return;
    await api(token, `/api/dropship/products/${id}`, { method: 'DELETE' });
    load();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="w-5 h-5 rounded-full border-2 border-white/10 border-t-[#d4ff00]/60 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {productModal && (
        <ProductModal
          token={token}
          product={productModal === true ? null : productModal}
          onClose={() => setProductModal(null)}
          onSaved={load}
        />
      )}
      {orderModal && (
        <ManualOrderModal token={token} products={products} onClose={() => setOrderModal(false)} onSaved={load} />
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-[#f2f2ef]">Dropshipping</h1>
          <p className="text-xs text-[#888880] mt-0.5">Gestión de pedidos Vinted → Temu</p>
        </div>
        <div className="flex items-center gap-2">
          {accounts.length > 0 && tab === 'orders' && (
            <div className="flex items-center gap-1.5">
              {accounts.map(acc => (
                <button
                  key={acc.id}
                  onClick={() => scanAccount(acc.id)}
                  disabled={scanning === acc.id}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.04] border border-white/[0.07] text-xs text-[#888880] hover:text-[#f2f2ef] hover:border-white/[0.12] transition disabled:opacity-40"
                >
                  {scanning === acc.id ? <RefreshCcw className="w-3 h-3 animate-spin" /> : <RefreshCcw className="w-3 h-3" />}
                  Escanear {acc.username}
                </button>
              ))}
            </div>
          )}
          {tab === 'orders' && (
            <button
              onClick={() => setOrderModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.04] border border-white/[0.07] text-xs text-[#888880] hover:text-[#f2f2ef] transition"
            >
              <Plus className="w-3.5 h-3.5" /> Pedido manual
            </button>
          )}
          {tab === 'products' && (
            <button
              onClick={() => setProductModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#d4ff00] text-black text-xs font-bold hover:bg-[#c8f000] transition"
            >
              <Plus className="w-3.5 h-3.5" /> Nuevo producto
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-white/[0.03] border border-white/[0.06] rounded-xl w-fit">
        {(['orders', 'products'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition ${
              tab === t ? 'bg-white/[0.08] text-[#f2f2ef]' : 'text-[#666660] hover:text-[#888880]'
            }`}
          >
            {t === 'orders' ? `Pedidos (${orders.length})` : `Catálogo (${products.length})`}
          </button>
        ))}
      </div>

      {/* Orders Kanban */}
      {tab === 'orders' && (
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3 min-h-[300px]">
          {COLUMNS.map(col => {
            const colOrders = orders.filter(o => o.status === col.status);
            return (
              <div key={col.status} className="space-y-2">
                <div className="flex items-center gap-1.5 px-1">
                  <span className={col.color}>{col.icon}</span>
                  <span className="text-[10px] font-semibold text-[#888880] uppercase tracking-wide">{col.label}</span>
                  <span className="ml-auto text-[10px] text-[#444440] font-mono">{colOrders.length}</span>
                </div>
                <div className="space-y-2 min-h-[80px]">
                  {colOrders.length === 0 ? (
                    <div className="h-16 rounded-xl border border-dashed border-white/[0.05] flex items-center justify-center">
                      <span className="text-[10px] text-[#333330]">vacío</span>
                    </div>
                  ) : (
                    colOrders.map(order => (
                      <OrderCard key={order.id} order={order} token={token} onRefresh={load} />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Products list */}
      {tab === 'products' && (
        <div className="space-y-2">
          {products.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Package className="w-8 h-8 text-[#333330]" />
              <p className="text-sm text-[#555550]">Sin productos en el catálogo</p>
              <button onClick={() => setProductModal(true)} className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#d4ff00] text-black text-xs font-bold">
                <Plus className="w-3.5 h-3.5" /> Añadir primer producto
              </button>
            </div>
          ) : (
            products.map(p => (
              <div key={p.id} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-[#f2f2ef] truncate">{p.title}</p>
                    {!p.is_active && <span className="text-[10px] text-zinc-500 border border-zinc-700 rounded px-1">inactivo</span>}
                  </div>
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    {p.temu_cost && <span className="text-[10px] text-[#888880]">Temu: {p.temu_cost}€</span>}
                    {p.vinted_price && <span className="text-[10px] text-[#d4ff00]/80">Vinted: {p.vinted_price}€</span>}
                    {p.temu_cost && p.vinted_price && (
                      <span className="text-[10px] text-green-400">Margen: {(p.vinted_price - p.temu_cost).toFixed(2)}€</span>
                    )}
                    <span className="text-[10px] text-[#555550]">Stock: {p.stock}</span>
                  </div>
                  {p.notes && <p className="text-[10px] text-[#555550] mt-1 truncate">{p.notes}</p>}
                  <a href={p.temu_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-400/70 hover:text-blue-400 truncate block mt-1 flex items-center gap-0.5">
                    <ExternalLink className="w-2.5 h-2.5" /> Temu
                  </a>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button onClick={() => setProductModal(p)} className="p-1.5 rounded-lg border border-white/[0.06] text-[#555550] hover:text-[#f2f2ef] transition">
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => deleteProduct(p.id)} className="p-1.5 rounded-lg border border-white/[0.06] text-[#555550] hover:text-red-400 transition">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
