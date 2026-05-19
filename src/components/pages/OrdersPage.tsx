import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { ShoppingBag, TrendingUp, DollarSign, Percent } from 'lucide-react';

interface Account {
  id: number;
  login: string;
}

interface Order {
  id: number;
  title: string;
  amount: number;
  buyPrice: number;
  profit: number;
  soldAt: string;
  accountLogin: string;
}

interface OrdersPageProps {
  token: string;
}

function KpiCard({ label, value, icon, accent }: { label: string; value: string; icon: React.ReactNode; accent?: boolean }) {
  return (
    <div className={`bg-[#161616] border rounded-2xl p-5 ${accent ? 'border-[#d4ff00]/20' : 'border-white/[0.06]'}`}>
      <div className="flex items-start justify-between mb-3">
        <span className="text-[0.72rem] font-medium uppercase tracking-widest text-[#888880]">{label}</span>
        <span className={accent ? 'text-[#d4ff00]' : 'text-[#888880]'}>{icon}</span>
      </div>
      <p className={`font-display text-[1.8rem] leading-none ${accent ? 'text-[#d4ff00]' : 'text-[#f2f2ef]'}`}>{value}</p>
    </div>
  );
}

export default function OrdersPage({ token }: OrdersPageProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<number | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingOrders, setLoadingOrders] = useState(false);

  const authHeaders = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    const loadAccounts = async () => {
      setLoadingAccounts(true);
      try {
        const res = await fetch('/api/vinted/accounts', { headers: authHeaders });
        const data = await res.json();
        const accs: Account[] = data.ok ? data.data.accounts : [];
        setAccounts(accs);
        if (accs.length > 0) setSelectedAccount(accs[0].id);
      } catch {}
      setLoadingAccounts(false);
    };
    loadAccounts();
  }, [token]);

  useEffect(() => {
    if (!selectedAccount) return;
    const loadOrders = async () => {
      setLoadingOrders(true);
      setOrders([]);
      try {
        const res = await fetch(`/api/vinted/${selectedAccount}/orders`, { headers: authHeaders });
        const data = await res.json();
        setOrders(data.ok ? data.data.orders : []);
      } catch {}
      setLoadingOrders(false);
    };
    loadOrders();
  }, [selectedAccount, token]);

  const totalRevenue = orders.reduce((s, o) => s + (o.amount || 0), 0);
  const totalProfit  = orders.reduce((s, o) => s + (o.profit || 0), 0);
  const margin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

  const fmt = (n: number) =>
    new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);

  return (
    <div className="space-y-6">
      <div>
        <p className="font-display text-[0.75rem] tracking-[0.3em] text-[#d4ff00]">VENTAS</p>
        <h1 className="font-display text-[2.4rem] leading-none tracking-[0.02em] text-[#f2f2ef] mt-1">Pedidos</h1>
      </div>

      {loadingAccounts ? (
        <div className="flex items-center justify-center h-32">
          <div className="w-6 h-6 border-2 border-[#d4ff00] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : accounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 border border-dashed border-white/[0.08] rounded-2xl text-center px-8">
          <div className="w-14 h-14 rounded-full bg-white/[0.03] flex items-center justify-center mb-4">
            <ShoppingBag className="w-7 h-7 text-white/15" />
          </div>
          <p className="text-[0.95rem] font-medium text-[#888880]">Sin cuentas vinculadas</p>
          <p className="text-[0.8rem] text-[#555550] mt-1">Ve a Cuentas para añadir una primero</p>
        </div>
      ) : (
        <>
          {/* Account tabs */}
          <div className="flex gap-2 flex-wrap">
            {accounts.map((acc) => (
              <button
                key={acc.id}
                onClick={() => setSelectedAccount(acc.id)}
                className={`px-4 py-2 rounded-xl text-[0.82rem] font-medium border transition-all ${
                  selectedAccount === acc.id
                    ? 'bg-[#d4ff00]/10 border-[#d4ff00]/30 text-[#d4ff00]'
                    : 'bg-white/[0.03] border-white/[0.06] text-[#888880] hover:text-[#f2f2ef] hover:border-white/[0.12]'
                }`}
              >
                {acc.login}
              </button>
            ))}
          </div>

          {loadingOrders ? (
            <div className="flex items-center justify-center h-48">
              <div className="w-6 h-6 border-2 border-[#d4ff00] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* KPIs */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <KpiCard label="Pedidos"       value={String(orders.length)} icon={<ShoppingBag className="w-4 h-4" />} />
                <KpiCard label="Revenue"       value={fmt(totalRevenue)}     icon={<DollarSign className="w-4 h-4" />} />
                <KpiCard label="Profit neto"   value={fmt(totalProfit)}      icon={<TrendingUp className="w-4 h-4" />} accent />
                <KpiCard label="Margen"        value={`${margin.toFixed(1)}%`} icon={<Percent className="w-4 h-4" />} />
              </div>

              {/* Table */}
              {orders.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 border border-dashed border-white/[0.08] rounded-2xl text-center">
                  <div className="w-12 h-12 rounded-full bg-white/[0.03] flex items-center justify-center mb-3">
                    <ShoppingBag className="w-6 h-6 text-white/15" />
                  </div>
                  <p className="text-[0.9rem] text-[#888880]">Sin pedidos registrados</p>
                </div>
              ) : (
                <div className="bg-[#161616] border border-white/[0.06] rounded-2xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-white/[0.06]">
                          {['Artículo', 'Precio venta', 'Precio compra', 'Profit', 'Fecha'].map(col => (
                            <th key={col} className="px-4 py-3 text-left text-[0.7rem] font-semibold uppercase tracking-widest text-[#888880]">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {orders.map((order, idx) => {
                          const profitPositive = (order.profit || 0) >= 0;
                          return (
                            <motion.tr
                              key={order.id}
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              transition={{ delay: Math.min(idx * 0.02, 0.4) }}
                              className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                            >
                              <td className="px-4 py-3">
                                <p className="text-[0.85rem] font-medium text-[#f2f2ef] max-w-[200px] truncate">{order.title}</p>
                                {order.accountLogin && (
                                  <p className="text-[0.7rem] text-[#888880]">{order.accountLogin}</p>
                                )}
                              </td>
                              <td className="px-4 py-3 font-mono text-[0.85rem] text-[#f2f2ef]">
                                {fmt(order.amount || 0)}
                              </td>
                              <td className="px-4 py-3 font-mono text-[0.85rem] text-[#888880]">
                                {order.buyPrice != null ? fmt(order.buyPrice) : '—'}
                              </td>
                              <td className="px-4 py-3 font-mono text-[0.85rem] font-semibold">
                                <span className={profitPositive ? 'text-[#d4ff00]' : 'text-[#ff8080]'}>
                                  {profitPositive ? '+' : ''}{fmt(order.profit || 0)}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-[0.78rem] text-[#888880]">
                                {order.soldAt
                                  ? new Date(order.soldAt).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit' })
                                  : '—'}
                              </td>
                            </motion.tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
