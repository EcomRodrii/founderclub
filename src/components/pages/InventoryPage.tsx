import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Package, ExternalLink, Eye, EyeOff, Heart } from 'lucide-react';

interface Account {
  id: number;
  login: string;
  country_code: string;
}

interface Item {
  id: number;
  item_id: number;
  title: string;
  price: number;
  status: 'active' | 'sold' | 'hidden';
  views: number;
  favorites: number;
  brand: string;
  size: string;
  url: string;
  image_url: string;
  listed_at: string;
}

interface InventoryPageProps {
  token: string;
}

type StatusFilter = 'all' | 'active' | 'sold' | 'hidden';

function ItemStatusBadge({ status }: { status: string }) {
  if (status === 'active') return (
    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#d4ff00]/10 text-[#d4ff00] border border-[#d4ff00]/20">Activo</span>
  );
  if (status === 'hidden') return (
    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#ff8080]/10 text-[#ff8080] border border-[#ff8080]/20">Oculto</span>
  );
  return (
    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/5 text-white/40 border border-white/[0.06]">Vendido</span>
  );
}

export default function InventoryPage({ token }: InventoryPageProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<number | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

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
    const loadItems = async () => {
      setLoadingItems(true);
      setItems([]);
      try {
        const res = await fetch(`/api/vinted/${selectedAccount}/items`, { headers: authHeaders });
        const data = await res.json();
        setItems(data.ok ? data.data.items : []);
      } catch {}
      setLoadingItems(false);
    };
    loadItems();
  }, [selectedAccount, token]);

  const filtered = statusFilter === 'all' ? items : items.filter(i => i.status === statusFilter);

  const STATUS_TABS: { id: StatusFilter; label: string }[] = [
    { id: 'all',    label: 'Todos' },
    { id: 'active', label: 'Activos' },
    { id: 'sold',   label: 'Vendidos' },
    { id: 'hidden', label: 'Ocultos' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <p className="font-display text-[0.75rem] tracking-[0.3em] text-[#d4ff00]">GESTIÓN</p>
        <h1 className="font-display text-[2.4rem] leading-none tracking-[0.02em] text-[#f2f2ef] mt-1">Inventario</h1>
      </div>

      {loadingAccounts ? (
        <div className="flex items-center justify-center h-32">
          <div className="w-6 h-6 border-2 border-[#d4ff00] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : accounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 border border-dashed border-white/[0.08] rounded-2xl text-center px-8">
          <div className="w-14 h-14 rounded-full bg-white/[0.03] flex items-center justify-center mb-4">
            <Package className="w-7 h-7 text-white/15" />
          </div>
          <p className="text-[0.95rem] font-medium text-[#888880]">Sin cuentas vinculadas</p>
          <p className="text-[0.8rem] text-[#555550] mt-1">Ve a Cuentas para añadir una primero</p>
        </div>
      ) : (
        <>
          {/* Account selector tabs */}
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

          {/* Status filter */}
          <div className="flex gap-1.5">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setStatusFilter(tab.id)}
                className={`px-3.5 py-1.5 rounded-full text-[0.78rem] font-medium border transition-all ${
                  statusFilter === tab.id
                    ? 'bg-white/[0.08] border-white/[0.16] text-[#f2f2ef]'
                    : 'bg-transparent border-white/[0.06] text-[#888880] hover:text-[#f2f2ef]'
                }`}
              >
                {tab.label}
                {tab.id !== 'all' && (
                  <span className="ml-1.5 text-[10px] opacity-60">
                    {items.filter(i => i.status === tab.id).length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {loadingItems ? (
            <div className="flex items-center justify-center h-48">
              <div className="w-6 h-6 border-2 border-[#d4ff00] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 border border-dashed border-white/[0.08] rounded-2xl text-center px-8">
              <div className="w-12 h-12 rounded-full bg-white/[0.03] flex items-center justify-center mb-3">
                <Package className="w-6 h-6 text-white/15" />
              </div>
              <p className="text-[0.9rem] font-medium text-[#888880]">Sin artículos</p>
              <p className="text-[0.78rem] text-[#555550] mt-1">No hay artículos con este filtro</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              <AnimatePresence>
                {filtered.map((item, idx) => (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ delay: Math.min(idx * 0.03, 0.3) }}
                    className="bg-[#161616] border border-white/[0.06] rounded-2xl overflow-hidden hover:border-white/[0.12] transition-colors group"
                  >
                    {/* Image */}
                    <div className="aspect-square relative overflow-hidden bg-[#1c1c1c]">
                      {item.image_url ? (
                        <img
                          src={item.image_url}
                          alt={item.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                          referrerPolicy="no-referrer"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Package className="w-8 h-8 text-white/10" />
                        </div>
                      )}
                      <div className="absolute top-2 left-2">
                        <ItemStatusBadge status={item.status} />
                      </div>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="absolute top-2 right-2 w-7 h-7 rounded-lg bg-black/60 backdrop-blur-sm flex items-center justify-center text-white/60 hover:text-white opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>

                    {/* Info */}
                    <div className="p-3">
                      <p className="text-[0.8rem] font-medium text-[#f2f2ef] truncate leading-snug mb-0.5">{item.title}</p>
                      {item.brand && (
                        <p className="text-[0.68rem] text-[#888880] truncate">{item.brand}{item.size ? ` · ${item.size}` : ''}</p>
                      )}
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-[0.85rem] font-semibold text-[#d4ff00] font-mono">
                          {item.price?.toFixed(2)} €
                        </span>
                        <div className="flex items-center gap-2 text-[#555550]">
                          <span className="flex items-center gap-0.5 text-[10px]">
                            <Eye className="w-3 h-3" /> {item.views || 0}
                          </span>
                          <span className="flex items-center gap-0.5 text-[10px]">
                            <Heart className="w-3 h-3" /> {item.favorites || 0}
                          </span>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </>
      )}
    </div>
  );
}
