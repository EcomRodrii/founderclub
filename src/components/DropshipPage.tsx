import React, { useState, useEffect, useCallback } from 'react';
import {
  RefreshCcw, Package, ShoppingCart, Truck, CheckCircle2, Send,
  Plus, Trash2, Edit2, Check, X, ExternalLink, Settings,
  AlertCircle, ChevronRight, Store, Link2, Info
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────
type Tab = 'orders' | 'catalog' | 'temu';
type OrderStatus = 'pending_purchase' | 'purchased_temu' | 'in_transit' | 'received' | 'shipped';

interface Product {
  id: number; temu_url: string; temu_cost: number | null;
  vinted_price: number | null; title: string; stock: number;
  notes: string | null; is_active: boolean;
}

interface Order {
  id: number; product_id: number | null; product_title: string | null;
  temu_url: string | null; vinted_order_id: string; buyer_name: string | null;
  vinted_item_title: string | null; vinted_amount: number | null;
  temu_order_id: string | null; status: OrderStatus; created_at: string;
}

interface VintedAccount { id: number; username: string; domain: string; }
interface TemuCreds { exists: boolean; email: string | null; }

// ── Step config ───────────────────────────────────────────────────────────────
// Visual 4-step flow shown to users (we collapse purchased_temu+in_transit → "en camino")
const STEPS: { label: string; statuses: OrderStatus[] }[] = [
  { label: 'Venta detectada',   statuses: ['pending_purchase'] },
  { label: 'Comprar en Temu',   statuses: ['pending_purchase'] }, // action step
  { label: 'En camino',         statuses: ['purchased_temu', 'in_transit'] },
  { label: 'Recibido y enviado',statuses: ['received', 'shipped'] },
];

function statusStep(status: OrderStatus) {
  if (status === 'pending_purchase') return 0;
  if (status === 'purchased_temu' || status === 'in_transit') return 2;
  if (status === 'received') return 3;
  return 4; // shipped
}

const STATUS_LABEL: Record<OrderStatus, string> = {
  pending_purchase: 'Pendiente de comprar',
  purchased_temu: 'Pedido en Temu',
  in_transit: 'En camino',
  received: 'Listo para enviar',
  shipped: 'Enviado',
};

const STATUS_NEXT: Record<OrderStatus, OrderStatus | null> = {
  pending_purchase: 'purchased_temu',
  purchased_temu: 'in_transit',
  in_transit: 'received',
  received: 'shipped',
  shipped: null,
};

const STATUS_COLOR: Record<OrderStatus, string> = {
  pending_purchase: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  purchased_temu: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
  in_transit: 'bg-violet-500/15 text-violet-400 border-violet-500/25',
  received: 'bg-green-500/15 text-green-400 border-green-500/25',
  shipped: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/25',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function api(token: string, path: string, opts?: RequestInit) {
  return fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts?.headers || {}) },
  });
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'ahora mismo';
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function ProgressBar({ status }: { status: OrderStatus }) {
  const step = statusStep(status);
  const shipped = status === 'shipped';
  const labels = ['Detectada', 'En Temu', 'En camino', 'Enviada'];
  return (
    <div className="flex items-center gap-0">
      {labels.map((label, i) => {
        const done = shipped || i < step;
        const active = !shipped && i === step;
        return (
          <React.Fragment key={i}>
            <div className="flex flex-col items-center gap-0.5" style={{ minWidth: 48 }}>
              <div className={`w-2 h-2 rounded-full border transition ${
                done ? 'bg-[#d4ff00] border-[#d4ff00]' :
                active ? 'border-[#d4ff00] bg-transparent' :
                'border-white/20 bg-transparent'
              }`} />
              <span className={`text-[9px] font-medium ${done || active ? 'text-[#888880]' : 'text-[#333330]'}`}>
                {label}
              </span>
            </div>
            {i < labels.length - 1 && (
              <div className={`h-px flex-1 mb-3 ${done ? 'bg-[#d4ff00]/50' : 'bg-white/[0.06]'}`} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Order card ────────────────────────────────────────────────────────────────
function OrderCard({ order, products, token, onRefresh }: {
  order: Order; products: Product[]; token: string; onRefresh: () => void;
}) {
  const [moving, setMoving] = useState(false);
  const [editTemuId, setEditTemuId] = useState(false);
  const [temuId, setTemuId] = useState(order.temu_order_id || '');
  const [assigningProduct, setAssigningProduct] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState(order.product_id?.toString() || '');

  const nextStatus = STATUS_NEXT[order.status];

  const moveNext = async (to?: OrderStatus) => {
    const target = to || nextStatus;
    if (!target) return;
    setMoving(true);
    await api(token, `/api/dropship/orders/${order.id}/status`, {
      method: 'PUT', body: JSON.stringify({ status: target }),
    });
    onRefresh();
    setMoving(false);
  };

  const saveTemuId = async () => {
    await api(token, `/api/dropship/orders/${order.id}/temu-order`, {
      method: 'PUT', body: JSON.stringify({ temu_order_id: temuId }),
    });
    setEditTemuId(false);
    onRefresh();
  };

  const assignProduct = async () => {
    await api(token, `/api/dropship/orders/${order.id}/temu-order`, {
      method: 'PUT', body: JSON.stringify({ product_id: selectedProductId || null }),
    });
    setAssigningProduct(false);
    onRefresh();
  };

  const temuUrl = order.temu_url || products.find(p => p.id === order.product_id)?.temu_url;

  return (
    <div className="bg-white/[0.03] border border-white/[0.07] rounded-2xl p-4 space-y-3 hover:border-white/[0.12] transition">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[#f2f2ef] leading-snug">
            {order.vinted_item_title || order.product_title || 'Artículo sin título'}
          </p>
          <p className="text-[10px] text-[#555550] mt-0.5">
            Vinta #{order.vinted_order_id.replace('item-', '')} · {timeAgo(order.created_at)}
            {order.buyer_name && ` · ${order.buyer_name}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {order.vinted_amount && (
            <span className="text-sm font-bold text-[#d4ff00]">{Number(order.vinted_amount).toFixed(2)}€</span>
          )}
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${STATUS_COLOR[order.status]}`}>
            {STATUS_LABEL[order.status]}
          </span>
        </div>
      </div>

      {/* Progress */}
      <ProgressBar status={order.status} />

      {/* Action area by status */}
      {order.status === 'pending_purchase' && (
        <div className="space-y-2 pt-1">
          {/* Product association */}
          {!order.product_id && (
            assigningProduct ? (
              <div className="flex gap-2">
                <select
                  value={selectedProductId}
                  onChange={e => setSelectedProductId(e.target.value)}
                  className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-xs text-[#f2f2ef] focus:outline-none"
                >
                  <option value="">— Sin producto del catálogo —</option>
                  {products.map(p => (
                    <option key={p.id} value={p.id}>{p.title}</option>
                  ))}
                </select>
                <button onClick={assignProduct} className="px-3 py-2 rounded-xl bg-[#d4ff00] text-black text-xs font-bold">
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setAssigningProduct(false)} className="px-3 py-2 rounded-xl border border-white/[0.08] text-zinc-500 text-xs">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setAssigningProduct(true)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl border border-dashed border-white/[0.12] text-xs text-[#555550] hover:text-[#888880] transition"
              >
                <Link2 className="w-3.5 h-3.5" />
                Asociar producto de Temu del catálogo
              </button>
            )
          )}

          {order.product_id && (
            <p className="text-[10px] text-[#555550]">
              Producto: {products.find(p => p.id === order.product_id)?.title || '—'}
            </p>
          )}

          {/* Temu buttons */}
          <div className="flex gap-2">
            {temuUrl && (
              <a
                href={temuUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-blue-500/30 text-blue-400 text-xs font-semibold hover:bg-blue-500/10 transition"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Abrir en Temu
              </a>
            )}
            <button
              onClick={() => moveNext('purchased_temu')}
              disabled={moving}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#d4ff00] text-black text-xs font-bold hover:bg-[#c8f000] disabled:opacity-40 transition"
            >
              {moving ? <RefreshCcw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Ya compré en Temu
            </button>
          </div>
        </div>
      )}

      {(order.status === 'purchased_temu' || order.status === 'in_transit') && (
        <div className="flex items-center gap-2">
          {/* Temu order ID */}
          {editTemuId ? (
            <div className="flex gap-2 flex-1">
              <input
                value={temuId}
                onChange={e => setTemuId(e.target.value)}
                placeholder="Número pedido Temu"
                className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-xs text-[#f2f2ef] focus:outline-none"
              />
              <button onClick={saveTemuId} className="px-3 rounded-xl bg-[#d4ff00] text-black">
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setEditTemuId(false)} className="px-3 rounded-xl border border-white/[0.08] text-zinc-500">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={() => setEditTemuId(true)}
                className="text-[10px] text-[#444440] hover:text-[#888880] transition flex items-center gap-1"
              >
                <Edit2 className="w-2.5 h-2.5" />
                {order.temu_order_id ? `#${order.temu_order_id}` : 'Anotar nº pedido Temu'}
              </button>
              <button
                onClick={() => moveNext()}
                disabled={moving}
                className="ml-auto flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#d4ff00] text-black text-xs font-bold hover:bg-[#c8f000] disabled:opacity-40 transition"
              >
                {moving ? <RefreshCcw className="w-3.5 h-3.5 animate-spin" /> : <Package className="w-3.5 h-3.5" />}
                Llegó el paquete
              </button>
            </>
          )}
        </div>
      )}

      {order.status === 'received' && (
        <button
          onClick={() => moveNext()}
          disabled={moving}
          className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#d4ff00] text-black text-xs font-bold hover:bg-[#c8f000] disabled:opacity-40 transition"
        >
          {moving ? <RefreshCcw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          Marcar como enviado al comprador
        </button>
      )}

      {order.status === 'shipped' && (
        <div className="flex items-center gap-2 text-[11px] text-green-400">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Pedido completado
        </div>
      )}
    </div>
  );
}

// ── Product modal ─────────────────────────────────────────────────────────────
function ProductModal({ token, product, onClose, onSaved }: {
  token: string; product: Product | null; onClose: () => void; onSaved: () => void;
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
    if (!form.title || !form.temu_url) { setErr('Nombre y URL de Temu son obligatorios'); return; }
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

  const FIELDS = [
    { key: 'title', label: 'Nombre del producto *', placeholder: 'Nike Air Max 97 blanco t.42' },
    { key: 'temu_url', label: 'URL de Temu *', placeholder: 'https://www.temu.com/...' },
    { key: 'temu_cost', label: 'Precio en Temu (€)', placeholder: '12.50' },
    { key: 'vinted_price', label: 'Precio en Vinted (€)', placeholder: '45.00' },
    { key: 'stock', label: 'Unidades en catálogo', placeholder: '1' },
    { key: 'notes', label: 'Notas (opcional)', placeholder: 'Variante específica, talla, color…' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-[#1a1a1a] border border-white/[0.08] rounded-2xl p-6 w-full max-w-md space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-[#f2f2ef]">{product ? 'Editar producto' : 'Añadir producto al catálogo'}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition"><X className="w-4 h-4" /></button>
        </div>
        {FIELDS.map(({ key, label, placeholder }) => (
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
        {form.temu_cost && form.vinted_price && (
          <div className="text-xs text-green-400 bg-green-500/10 rounded-xl px-3 py-2">
            Margen estimado: {(parseFloat(form.vinted_price) - parseFloat(form.temu_cost)).toFixed(2)}€ por venta
          </div>
        )}
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

// ── Temu credentials tab ──────────────────────────────────────────────────────
function TemuTab({ token, temu, onSaved }: { token: string; temu: TemuCreds | null; onSaved: () => void }) {
  const [cookies, setCookies] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);

  const save = async () => {
    if (!cookies.trim()) { setErr('Pega las cookies de Temu'); return; }
    setSaving(true); setErr(''); setOk(false);
    const r = await api(token, '/api/dropship/temu-credentials', {
      method: 'POST',
      body: JSON.stringify({ cookies_json: cookies.trim(), email: email.trim() || null }),
    });
    if (r.ok) { setOk(true); setCookies(''); onSaved(); }
    else { const d = await r.json(); setErr(d.error || 'Error'); }
    setSaving(false);
  };

  return (
    <div className="space-y-5 max-w-lg">
      {/* Status */}
      <div className={`flex items-center gap-3 p-4 rounded-2xl border ${
        temu?.exists
          ? 'bg-green-500/10 border-green-500/20'
          : 'bg-amber-500/10 border-amber-500/20'
      }`}>
        <div className={`w-2 h-2 rounded-full ${temu?.exists ? 'bg-green-400' : 'bg-amber-400'}`} />
        <div>
          <p className={`text-sm font-semibold ${temu?.exists ? 'text-green-400' : 'text-amber-400'}`}>
            {temu?.exists ? 'Cuenta Temu conectada' : 'Temu no configurado'}
          </p>
          {temu?.exists && temu.email && (
            <p className="text-xs text-[#888880] mt-0.5">{temu.email}</p>
          )}
          {!temu?.exists && (
            <p className="text-xs text-[#888880] mt-0.5">
              Sin Temu conectado, tendrás que comprar manualmente abriendo el enlace
            </p>
          )}
        </div>
      </div>

      {/* Instructions */}
      <div className="space-y-3">
        <h3 className="text-sm font-bold text-[#f2f2ef]">
          {temu?.exists ? 'Actualizar cookies de Temu' : 'Conectar tu cuenta de Temu'}
        </h3>

        <div className="space-y-2">
          {[
            'Abre temu.com en Chrome y entra en tu cuenta de Temu',
            'Pulsa F12 para abrir las herramientas de desarrollador',
            'Ve a la pestaña "Application" (o "Aplicación")',
            'En la columna izquierda: Cookies → https://www.temu.com',
            'Selecciona todas las cookies, cópiolas y pégalas abajo',
          ].map((step, i) => (
            <div key={i} className="flex items-start gap-3">
              <span className="shrink-0 w-5 h-5 rounded-full bg-white/[0.06] text-[10px] font-bold text-[#888880] flex items-center justify-center mt-0.5">
                {i + 1}
              </span>
              <p className="text-xs text-[#888880] leading-relaxed">{step}</p>
            </div>
          ))}
        </div>

        <div className="p-3 bg-white/[0.02] border border-white/[0.06] rounded-xl text-[10px] text-[#555550] flex items-start gap-2">
          <Info className="w-3 h-3 shrink-0 mt-0.5 text-[#444440]" />
          <span>
            Las cookies se guardan encriptadas y solo sirven para que el servidor abra Temu en tu nombre.
            Si Temu cierra tu sesión, tendrás que volver a pegar las cookies.
          </span>
        </div>
      </div>

      {/* Form */}
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-[#888880] mb-1">
            Cookies de Temu <span className="text-red-400">*</span>
          </label>
          <textarea
            value={cookies}
            onChange={e => setCookies(e.target.value)}
            placeholder="Pega aquí las cookies copiadas de las herramientas de desarrollador de Chrome…"
            rows={5}
            className="w-full bg-white/[0.04] border border-white/[0.07] rounded-xl px-3 py-2 text-xs text-[#f2f2ef] placeholder-[#444] focus:outline-none focus:border-[#d4ff00]/40 transition font-mono resize-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[#888880] mb-1">Email de Temu (opcional)</label>
          <input
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="tu@email.com"
            className="w-full bg-white/[0.04] border border-white/[0.07] rounded-xl px-3 py-2 text-xs text-[#f2f2ef] placeholder-[#444] focus:outline-none focus:border-[#d4ff00]/40 transition"
          />
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
        {ok && <p className="text-xs text-green-400">Cuenta de Temu guardada correctamente</p>}
        <button
          onClick={save}
          disabled={saving || !cookies.trim()}
          className="w-full py-2.5 rounded-xl bg-[#d4ff00] text-black text-sm font-bold hover:bg-[#c8f000] disabled:opacity-40 transition"
        >
          {saving ? 'Guardando…' : 'Guardar cookies de Temu'}
        </button>
      </div>

      <div className="p-3 bg-white/[0.02] border border-white/[0.06] rounded-xl">
        <p className="text-[10px] text-[#555550]">
          <span className="text-[#888880] font-semibold">¿Sin cuenta Temu?</span> Puedes usar la app igual — cuando detecte una venta en Vinted,
          te mostrará el enlace directo al producto en Temu para que lo compres tú mismo.
        </p>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DropshipPage({ token }: { token: string }) {
  const [tab, setTab] = useState<Tab>('orders');
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [accounts, setAccounts] = useState<VintedAccount[]>([]);
  const [temu, setTemu] = useState<TemuCreds | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [productModal, setProductModal] = useState<Product | true | null>(null);
  const [filterStatus, setFilterStatus] = useState<OrderStatus | 'all'>('all');

  const load = useCallback(async () => {
    const [pRes, oRes, aRes, tRes] = await Promise.all([
      api(token, '/api/dropship/products').then(r => r.json()).catch(() => []),
      api(token, '/api/dropship/orders').then(r => r.json()).catch(() => []),
      api(token, '/api/dropship/vinted-accounts').then(r => r.json()).catch(() => []),
      api(token, '/api/dropship/temu-credentials').then(r => r.json()).catch(() => ({ exists: false })),
    ]);
    setProducts(Array.isArray(pRes) ? pRes : []);
    setOrders(Array.isArray(oRes) ? oRes : []);
    setAccounts(Array.isArray(aRes) ? aRes : []);
    setTemu(tRes?.exists !== undefined ? tRes : { exists: false, email: null });
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const scanAll = async () => {
    setScanning(true);
    const r = await api(token, '/api/dropship/scan-all', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      if (d.new_orders > 0) alert(`✅ ${d.new_orders} venta(s) nueva(s) detectada(s) en Vinted`);
      load();
    } else {
      alert('Error al escanear: ' + (d.error || 'desconocido'));
    }
    setScanning(false);
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

  const filteredOrders = filterStatus === 'all'
    ? orders
    : orders.filter(o => o.status === filterStatus);

  const pendingCount = orders.filter(o => o.status === 'pending_purchase').length;

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

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-[#f2f2ef]">Dropshipping</h1>
          <p className="text-xs text-[#555550] mt-0.5">Vinted → Temu → Reenvío automático</p>
        </div>
        <button
          onClick={scanAll}
          disabled={scanning || accounts.length === 0}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white/[0.05] border border-white/[0.08] text-xs text-[#888880] hover:text-[#f2f2ef] hover:border-white/[0.14] disabled:opacity-40 transition"
        >
          <RefreshCcw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
          {scanning ? 'Comprobando…' : 'Comprobar ventas'}
        </button>
      </div>

      {/* Status strip */}
      <div className="flex flex-wrap items-center gap-2">
        <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-medium ${
          accounts.length > 0
            ? 'bg-green-500/10 border-green-500/20 text-green-400'
            : 'bg-white/[0.03] border-white/[0.07] text-[#555550]'
        }`}>
          <div className={`w-1.5 h-1.5 rounded-full ${accounts.length > 0 ? 'bg-green-400' : 'bg-zinc-600'}`} />
          Vinted: {accounts.length > 0 ? accounts.map(a => `@${a.username}`).join(', ') : 'Sin cuentas'}
        </div>
        <div
          onClick={() => setTab('temu')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-medium cursor-pointer transition ${
            temu?.exists
              ? 'bg-green-500/10 border-green-500/20 text-green-400 hover:bg-green-500/15'
              : 'bg-amber-500/10 border-amber-500/20 text-amber-400 hover:bg-amber-500/15'
          }`}
        >
          <div className={`w-1.5 h-1.5 rounded-full ${temu?.exists ? 'bg-green-400' : 'bg-amber-400'}`} />
          Temu: {temu?.exists ? 'Conectado' : 'No configurado — haz clic'}
        </div>
        {accounts.length === 0 && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/20 text-[11px] text-red-400">
            <AlertCircle className="w-3 h-3" />
            Añade cuentas Vinted en la pestaña "Cuentas"
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-white/[0.03] border border-white/[0.06] rounded-xl w-fit">
        {([
          { id: 'orders', label: `Pedidos${orders.length ? ` (${orders.length})` : ''}`, badge: pendingCount },
          { id: 'catalog', label: `Catálogo (${products.length})`, badge: 0 },
          { id: 'temu', label: 'Cuenta Temu', badge: temu?.exists ? 0 : 1 },
        ] as const).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`relative px-4 py-1.5 rounded-lg text-xs font-semibold transition ${
              tab === t.id ? 'bg-white/[0.08] text-[#f2f2ef]' : 'text-[#666660] hover:text-[#888880]'
            }`}
          >
            {t.label}
            {t.badge > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-amber-500 text-[8px] font-bold text-black flex items-center justify-center">
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── TAB: PEDIDOS ── */}
      {tab === 'orders' && (
        <div className="space-y-4">
          {/* Filter */}
          {orders.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {(['all', 'pending_purchase', 'purchased_temu', 'in_transit', 'received', 'shipped'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setFilterStatus(s)}
                  className={`px-3 py-1 rounded-full text-[10px] font-semibold border transition ${
                    filterStatus === s
                      ? 'bg-[#d4ff00]/15 border-[#d4ff00]/30 text-[#d4ff00]'
                      : 'bg-white/[0.02] border-white/[0.07] text-[#555550] hover:text-[#888880]'
                  }`}
                >
                  {s === 'all' ? `Todos (${orders.length})` : `${STATUS_LABEL[s]} (${orders.filter(o => o.status === s).length})`}
                </button>
              ))}
            </div>
          )}

          {/* Orders */}
          {filteredOrders.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-5 text-center">
              <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.07] flex items-center justify-center">
                <ShoppingCart className="w-6 h-6 text-[#333330]" />
              </div>
              <div>
                <p className="text-sm font-semibold text-[#555550] mb-1">
                  {filterStatus !== 'all' ? 'No hay pedidos con este filtro' : 'Sin ventas detectadas aún'}
                </p>
                {filterStatus === 'all' && (
                  <p className="text-xs text-[#444440] max-w-xs">
                    Cuando vendas un artículo en Vinted, aparecerá aquí automáticamente.
                    Pulsa "Comprobar ventas" para buscar ahora.
                  </p>
                )}
              </div>
              {filterStatus === 'all' && accounts.length > 0 && (
                <button
                  onClick={scanAll}
                  disabled={scanning}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#d4ff00] text-black text-xs font-bold hover:bg-[#c8f000] disabled:opacity-40 transition"
                >
                  <RefreshCcw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
                  Buscar ventas ahora
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredOrders.map(order => (
                <OrderCard
                  key={order.id}
                  order={order}
                  products={products}
                  token={token}
                  onRefresh={load}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TAB: CATÁLOGO ── */}
      {tab === 'catalog' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-[#f2f2ef]">Catálogo de productos</p>
              <p className="text-[11px] text-[#555550] mt-0.5">
                Los productos que vendes en Vinted y compras en Temu. Añade aquí la URL de Temu y los precios.
              </p>
            </div>
            <button
              onClick={() => setProductModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#d4ff00] text-black text-xs font-bold hover:bg-[#c8f000] transition"
            >
              <Plus className="w-3.5 h-3.5" /> Añadir producto
            </button>
          </div>

          {products.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <Package className="w-8 h-8 text-[#333330]" />
              <div className="text-center">
                <p className="text-sm font-semibold text-[#555550]">Sin productos en el catálogo</p>
                <p className="text-xs text-[#444440] mt-1">
                  Añade los productos que vendes en Vinted con su URL de Temu
                </p>
              </div>
              <button onClick={() => setProductModal(true)} className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#d4ff00] text-black text-xs font-bold">
                <Plus className="w-3.5 h-3.5" /> Añadir primer producto
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {products.map(p => (
                <div key={p.id} className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-[#f2f2ef] truncate">{p.title}</p>
                        {!p.is_active && <span className="text-[9px] text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">inactivo</span>}
                      </div>
                      <div className="flex items-center gap-4 mt-2 flex-wrap">
                        {p.temu_cost != null && (
                          <div className="text-center">
                            <p className="text-[9px] text-[#555550] uppercase tracking-wide">Precio Temu</p>
                            <p className="text-xs font-semibold text-[#888880]">{p.temu_cost}€</p>
                          </div>
                        )}
                        {p.vinted_price != null && (
                          <div className="text-center">
                            <p className="text-[9px] text-[#555550] uppercase tracking-wide">Precio Vinted</p>
                            <p className="text-xs font-semibold text-[#d4ff00]">{p.vinted_price}€</p>
                          </div>
                        )}
                        {p.temu_cost != null && p.vinted_price != null && (
                          <div className="text-center">
                            <p className="text-[9px] text-[#555550] uppercase tracking-wide">Margen</p>
                            <p className="text-xs font-semibold text-green-400">
                              {(p.vinted_price - p.temu_cost).toFixed(2)}€
                            </p>
                          </div>
                        )}
                        <div className="text-center">
                          <p className="text-[9px] text-[#555550] uppercase tracking-wide">Stock</p>
                          <p className="text-xs font-semibold text-[#888880]">{p.stock}</p>
                        </div>
                      </div>
                      {p.notes && (
                        <p className="text-[10px] text-[#444440] mt-1.5 truncate">{p.notes}</p>
                      )}
                    </div>
                    <div className="flex gap-1.5 shrink-0 items-start">
                      <a
                        href={p.temu_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded-lg border border-white/[0.06] text-[#555550] hover:text-blue-400 hover:border-blue-500/30 transition"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                      <button
                        onClick={() => setProductModal(p)}
                        className="p-1.5 rounded-lg border border-white/[0.06] text-[#555550] hover:text-[#f2f2ef] hover:border-white/[0.12] transition"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => deleteProduct(p.id)}
                        className="p-1.5 rounded-lg border border-white/[0.06] text-[#555550] hover:text-red-400 hover:border-red-500/30 transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TAB: CUENTA TEMU ── */}
      {tab === 'temu' && (
        <TemuTab token={token} temu={temu} onSaved={load} />
      )}
    </div>
  );
}
