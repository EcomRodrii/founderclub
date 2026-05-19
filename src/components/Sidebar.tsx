import React from 'react';
import { motion } from 'motion/react';
import {
  LayoutDashboard,
  Users,
  Package,
  ShoppingBag,
  Zap,
  Settings,
  LogOut,
  ShieldCheck,
} from 'lucide-react';

export type Page = 'dashboard' | 'accounts' | 'inventory' | 'orders' | 'boost' | 'settings';

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  user: { username: string; email: string; is_admin?: boolean };
  onLogout: () => void;
  onAdmin?: () => void;
}

const NAV_ITEMS: { id: Page; label: string; icon: React.ReactNode }[] = [
  { id: 'dashboard',  label: 'Dashboard',    icon: <LayoutDashboard className="w-[18px] h-[18px]" /> },
  { id: 'accounts',   label: 'Cuentas',      icon: <Users            className="w-[18px] h-[18px]" /> },
  { id: 'inventory',  label: 'Inventario',   icon: <Package          className="w-[18px] h-[18px]" /> },
  { id: 'orders',     label: 'Pedidos',      icon: <ShoppingBag      className="w-[18px] h-[18px]" /> },
  { id: 'boost',      label: 'Boost',        icon: <Zap              className="w-[18px] h-[18px]" /> },
  { id: 'settings',   label: 'Configuración',icon: <Settings         className="w-[18px] h-[18px]" /> },
];

export default function Sidebar({ currentPage, onNavigate, user, onLogout, onAdmin }: SidebarProps) {
  const initials = user.username.slice(0, 2).toUpperCase();

  return (
    <aside className="hidden lg:flex flex-col w-[240px] shrink-0 h-screen sticky top-0 bg-[#111111] border-r border-white/[0.06] z-30">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-6 py-7">
        <span className="w-2 h-2 rounded-sm bg-[#d4ff00] shadow-[0_0_12px_rgba(212,255,0,0.55)]" />
        <span className="font-display text-[1.6rem] leading-none tracking-[0.06em] text-[#f2f2ef]">
          LAMINE
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const active = currentPage === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[0.86rem] font-medium transition-all ease-hub group ${
                active
                  ? 'bg-[#d4ff00]/10 text-[#d4ff00]'
                  : 'text-[#888880] hover:text-[#f2f2ef] hover:bg-white/[0.04]'
              }`}
            >
              <span className={active ? 'text-[#d4ff00]' : 'text-[#555550] group-hover:text-[#f2f2ef] transition-colors'}>
                {item.icon}
              </span>
              {item.label}
              {active && (
                <motion.span
                  layoutId="sidebar-indicator"
                  className="ml-auto w-1 h-4 rounded-full bg-[#d4ff00]"
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-3 pb-5 pt-4 border-t border-white/[0.06] space-y-1">
        {onAdmin && (
          <button
            onClick={onAdmin}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[0.82rem] font-medium text-[#888880] hover:text-[#d4ff00] hover:bg-[#d4ff00]/[0.06] transition-all"
          >
            <ShieldCheck className="w-[16px] h-[16px]" />
            Panel Admin
          </button>
        )}
        <div className="flex items-center gap-3 px-3 py-2.5">
          <div className="w-7 h-7 rounded-full bg-[#d4ff00]/10 border border-[#d4ff00]/20 flex items-center justify-center shrink-0">
            <span className="text-[10px] font-bold text-[#d4ff00]">{initials}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[0.82rem] font-semibold text-[#f2f2ef] truncate">{user.username}</p>
            <p className="text-[0.7rem] text-[#888880] truncate">{user.email}</p>
          </div>
          <button
            onClick={onLogout}
            title="Cerrar sesión"
            className="text-[#555550] hover:text-[#ff8080] transition-colors shrink-0"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ── Mobile bottom tab bar ─────────────────────────────────────────────────── */

const MOBILE_ITEMS: { id: Page; label: string; icon: React.ReactNode }[] = [
  { id: 'dashboard', label: 'Inicio',    icon: <LayoutDashboard className="w-5 h-5" /> },
  { id: 'accounts',  label: 'Cuentas',  icon: <Users            className="w-5 h-5" /> },
  { id: 'inventory', label: 'Items',    icon: <Package          className="w-5 h-5" /> },
  { id: 'orders',    label: 'Pedidos',  icon: <ShoppingBag      className="w-5 h-5" /> },
  { id: 'boost',     label: 'Boost',    icon: <Zap              className="w-5 h-5" /> },
  { id: 'settings',  label: 'Config',   icon: <Settings         className="w-5 h-5" /> },
];

export function MobileTabBar({ currentPage, onNavigate }: { currentPage: Page; onNavigate: (p: Page) => void }) {
  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-[rgba(10,10,10,0.92)] backdrop-blur-xl border-t border-white/[0.08] safe-area-inset-bottom">
      <div className="flex items-center justify-around px-1 py-2">
        {MOBILE_ITEMS.map((item) => {
          const active = currentPage === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-xl transition-all ${
                active ? 'text-[#d4ff00]' : 'text-[#555550]'
              }`}
            >
              {item.icon}
              <span className="text-[9px] font-medium uppercase tracking-wider">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
