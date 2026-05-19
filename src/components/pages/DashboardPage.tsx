import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { TrendingUp, ShoppingBag, DollarSign, Package, ArrowUpRight, Users } from 'lucide-react';

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

interface DailyOrder {
  date: string;
  count: number;
}

interface DashboardPageProps {
  token: string;
}

function KpiCard({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-[#161616] border border-white/[0.06] rounded-2xl p-5 hover:border-white/[0.12] transition-colors"
    >
      <div className="flex items-start justify-between mb-4">
        <span className="text-[0.75rem] font-medium uppercase tracking-widest text-[#888880]">{label}</span>
        <span className="text-[#888880]">{icon}</span>
      </div>
      <p className="font-display text-[2rem] leading-none text-[#f2f2ef]">{value}</p>
      {sub && <p className="text-[0.75rem] text-[#888880] mt-1.5">{sub}</p>}
    </motion.div>
  );
}

function BarChart({ data }: { data: DailyOrder[] }) {
  if (!data.length) return null;
  const max = Math.max(...data.map(d => d.count), 1);

  return (
    <div className="flex items-end gap-1.5 h-28 w-full">
      {data.map((d) => {
        const heightPct = Math.max((d.count / max) * 100, 4);
        const label = new Date(d.date).toLocaleDateString('es-ES', { weekday: 'short' });
        return (
          <div key={d.date} className="flex-1 flex flex-col items-center gap-1.5 group">
            <span className="text-[10px] text-[#888880] opacity-0 group-hover:opacity-100 transition-opacity tabular-nums">
              {d.count}
            </span>
            <div className="w-full flex items-end" style={{ height: '80px' }}>
              <div
                className="w-full rounded-t-[4px] bg-[#d4ff00]/20 group-hover:bg-[#d4ff00]/50 transition-colors"
                style={{ height: `${heightPct}%` }}
              />
            </div>
            <span className="text-[9px] uppercase text-[#555550]">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#d4ff00]/10 text-[#d4ff00] border border-[#d4ff00]/20">
        <span className="w-1.5 h-1.5 rounded-full bg-[#d4ff00]" />
        Activa
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/5 text-white/40 border border-white/10">
      <span className="w-1.5 h-1.5 rounded-full bg-white/30" />
      Inactiva
    </span>
  );
}

export default function DashboardPage({ token }: DashboardPageProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalRevenue, setTotalRevenue] = useState(0);
  const [totalOrders, setTotalOrders] = useState(0);
  const [avgOrder, setAvgOrder] = useState(0);
  const [totalItems, setTotalItems] = useState(0);
  const [chartData, setChartData] = useState<DailyOrder[]>([]);

  const authHeaders = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    const loadDashboard = async () => {
      setLoading(true);
      try {
        const accRes = await fetch('/api/vinted/accounts', { headers: authHeaders });
        const accData = await accRes.json();
        const accs: Account[] = accData.ok ? accData.data.accounts : [];
        setAccounts(accs);

        let rev = 0;
        let orders = 0;
        let items = 0;
        const dailyMap: Record<string, number> = {};

        await Promise.all(
          accs.map(async (acc) => {
            try {
              const [statsRes, ordersRes] = await Promise.all([
                fetch(`/api/vinted/${acc.id}/stats`, { headers: authHeaders }),
                fetch(`/api/vinted/${acc.id}/orders`, { headers: authHeaders }),
              ]);
              const [statsData, ordersData] = await Promise.all([statsRes.json(), ordersRes.json()]);

              if (statsData.ok) {
                rev += statsData.data.sales.revenue || 0;
                orders += statsData.data.sales.totalOrders || 0;
                items += statsData.data.inventory.active || 0;
              }
              if (ordersData.ok) {
                for (const order of ordersData.data.orders) {
                  const day = order.soldAt ? order.soldAt.slice(0, 10) : '';
                  if (day) dailyMap[day] = (dailyMap[day] || 0) + 1;
                }
              }
            } catch {}
          })
        );

        setTotalRevenue(rev);
        setTotalOrders(orders);
        setAvgOrder(orders > 0 ? rev / orders : 0);
        setTotalItems(items);

        const last7: DailyOrder[] = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const key = d.toISOString().slice(0, 10);
          last7.push({ date: key, count: dailyMap[key] || 0 });
        }
        setChartData(last7);
      } catch {}
      setLoading(false);
    };

    loadDashboard();
  }, [token]);

  const fmt = (n: number) =>
    new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);

  return (
    <div className="space-y-8">
      <div>
        <p className="font-display text-[0.75rem] tracking-[0.3em] text-[#d4ff00]">PANEL DE CONTROL</p>
        <h1 className="font-display text-[2.4rem] leading-none tracking-[0.02em] text-[#f2f2ef] mt-1">Dashboard</h1>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="w-6 h-6 border-2 border-[#d4ff00] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard label="Revenue total"   value={fmt(totalRevenue)} icon={<DollarSign className="w-4 h-4" />} />
            <KpiCard label="Pedidos"         value={String(totalOrders)} icon={<ShoppingBag className="w-4 h-4" />} />
            <KpiCard label="Ticket medio"    value={fmt(avgOrder)} icon={<TrendingUp className="w-4 h-4" />} />
            <KpiCard label="Artículos activos" value={String(totalItems)} icon={<Package className="w-4 h-4" />} />
          </div>

          <div className="grid lg:grid-cols-[1fr_320px] gap-6">
            <div className="bg-[#161616] border border-white/[0.06] rounded-2xl p-6 hover:border-white/[0.12] transition-colors">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <p className="text-[0.85rem] font-semibold text-[#f2f2ef]">Pedidos — últimos 7 días</p>
                  <p className="text-[0.75rem] text-[#888880] mt-0.5">{totalOrders} pedidos en total</p>
                </div>
                <ArrowUpRight className="w-4 h-4 text-[#888880]" />
              </div>
              {chartData.every(d => d.count === 0) ? (
                <div className="h-28 flex items-center justify-center text-sm text-[#888880]">Sin datos de pedidos aún</div>
              ) : (
                <BarChart data={chartData} />
              )}
            </div>

            <div className="bg-[#161616] border border-white/[0.06] rounded-2xl p-6 hover:border-white/[0.12] transition-colors">
              <div className="flex items-center gap-2 mb-5">
                <Users className="w-4 h-4 text-[#888880]" />
                <p className="text-[0.85rem] font-semibold text-[#f2f2ef]">Cuentas vinculadas</p>
                <span className="ml-auto text-[0.75rem] font-medium text-[#888880] bg-white/[0.05] px-2 py-0.5 rounded-full">
                  {accounts.length}
                </span>
              </div>
              {accounts.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-32 text-center">
                  <div className="w-10 h-10 rounded-full bg-white/[0.04] flex items-center justify-center mb-3">
                    <Users className="w-5 h-5 text-white/20" />
                  </div>
                  <p className="text-[0.8rem] text-[#888880]">Sin cuentas vinculadas</p>
                  <p className="text-[0.72rem] text-[#555550] mt-1">Ve a Cuentas para añadir una</p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {accounts.slice(0, 6).map((acc) => (
                    <li key={acc.id} className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-full bg-[#d4ff00]/10 border border-[#d4ff00]/20 flex items-center justify-center shrink-0">
                        <span className="text-[10px] font-bold text-[#d4ff00]">
                          {acc.login.slice(0, 2).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[0.8rem] font-medium text-[#f2f2ef] truncate">{acc.login}</p>
                        <p className="text-[0.7rem] text-[#888880]">{acc.items_count} items · {acc.country_code?.toUpperCase()}</p>
                      </div>
                      <StatusBadge status={acc.status} />
                    </li>
                  ))}
                  {accounts.length > 6 && (
                    <li className="text-[0.75rem] text-[#888880] pt-1 text-center">+{accounts.length - 6} más</li>
                  )}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
