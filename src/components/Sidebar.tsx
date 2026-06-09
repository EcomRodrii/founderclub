import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  LayoutDashboard, Users, Package, ShoppingBag, Zap, Settings,
  LogOut, ShieldCheck, Scissors, Ghost, TrendingUp,
  MoreHorizontal, X, Lock, Send,
} from 'lucide-react';

export type Page =
  | 'dashboard' | 'accounts' | 'inventory' | 'orders'
  | 'profits' | 'tongue' | 'photos' | 'boost' | 'settings' | 'publish';

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  user: { username: string; email: string; is_admin?: boolean };
  allowedPages: Set<Page>;
  onLogout: () => void;
  onAdmin?: () => void;
}

const NAV_MAIN: { id: Page; label: string; icon: React.ReactNode }[] = [
  { id: 'dashboard', label: 'Dashboard',  icon: <LayoutDashboard className="w-[18px] h-[18px]" /> },
  { id: 'accounts',  label: 'Cuentas',    icon: <Users           className="w-[18px] h-[18px]" /> },
  { id: 'inventory', label: 'Inventario', icon: <Package         className="w-[18px] h-[18px]" /> },
  { id: 'orders',    label: 'Pedidos',    icon: <ShoppingBag     className="w-[18px] h-[18px]" /> },
];

const NAV_TOOLS: { id: Page; label: string; icon: React.ReactNode }[] = [
  { id: 'publish', label: 'Autopublicar',  icon: <Send       className="w-[18px] h-[18px]" /> },
  { id: 'profits', label: 'Beneficios',    icon: <TrendingUp className="w-[18px] h-[18px]" /> },
  { id: 'tongue',  label: 'Lengüeta',      icon: <Scissors   className="w-[18px] h-[18px]" /> },
  { id: 'photos',  label: 'Fantasma',      icon: <Ghost      className="w-[18px] h-[18px]" /> },
  { id: 'boost',   label: 'Boost',         icon: <Zap        className="w-[18px] h-[18px]" /> },
  { id: 'settings',label: 'Configuración', icon: <Settings   className="w-[18px] h-[18px]" /> },
];

function NavBtn({
  item, active, locked, onNavigate,
}: {
  item: { id: Page; label: string; icon: React.ReactNode };
  active: boolean;
  locked: boolean;
  onNavigate: (p: Page) => void;
}) {
  return (
    <button
      onClick={() => onNavigate(item.id)}
      title={locked ? 'Necesitas estar en la academia de Lamine' : undefined}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[0.86rem] font-medium transition-all group ${
        locked
          ? 'text-[#444440] cursor-pointer hover:bg-white/[0.02]'
          : active
            ? 'bg-[#d4ff00]/10 text-[#d4ff00]'
            : 'text-[#888880] hover:text-[#f2f2ef] hover:bg-white/[0.04]'
      }`}
    >
      <span className={
        locked ? 'text-[#333330]' :
        active  ? 'text-[#d4ff00]' :
        'text-[#555550] group-hover:text-[#f2f2ef] transition-colors'
      }>
        {item.icon}
      </span>
      <span className={locked ? 'opacity-40' : ''}>{item.label}</span>
      {locked && <Lock className="ml-auto w-3 h-3 text-[#333330]" />}
      {!locked && active && <motion.span layoutId="sidebar-indicator" className="ml-auto w-1 h-4 rounded-full bg-[#d4ff00]" />}
    </button>
  );
}

export default function Sidebar({ currentPage, onNavigate, user, allowedPages, onLogout, onAdmin }: SidebarProps) {
  const initials = user.username.slice(0, 2).toUpperCase();

  return (
    <aside className="hidden lg:flex flex-col w-[240px] shrink-0 h-screen sticky top-0 bg-[#111111] border-r border-white/[0.06] z-30">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-6 py-7">
        <span className="w-2 h-2 rounded-sm bg-[#d4ff00] shadow-[0_0_12px_rgba(212,255,0,0.55)]" />
        <span className="font-display text-[1.6rem] leading-none tracking-[0.06em] text-[#f2f2ef]">LAMINE</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 overflow-y-auto space-y-0.5">
        {NAV_MAIN.map(item => (
          <NavBtn key={item.id} item={item}
            active={currentPage === item.id}
            locked={!allowedPages.has(item.id)}
            onNavigate={onNavigate}
          />
        ))}

        <div className="pt-3 pb-1 px-3">
          <span className="text-[10px] uppercase tracking-widest text-[#444440] font-semibold">Herramientas</span>
        </div>
        {NAV_TOOLS.map(item => (
          <NavBtn key={item.id} item={item}
            active={currentPage === item.id}
            locked={!allowedPages.has(item.id)}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      {/* Footer */}
      <div className="px-3 pb-5 pt-4 border-t border-white/[0.06] space-y-1">
        {onAdmin && (
          <button onClick={onAdmin} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[0.82rem] font-medium text-[#888880] hover:text-[#d4ff00] hover:bg-[#d4ff00]/[0.06] transition-all">
            <ShieldCheck className="w-[16px] h-[16px]" /> Panel Admin
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
          <button onClick={onLogout} title="Cerrar sesión" className="text-[#555550] hover:text-[#ff8080] transition-colors shrink-0">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ── Mobile bottom tab bar ─────────────────────────────────────────────────── */

const MOBILE_MAIN: { id: Page; label: string; icon: React.ReactNode }[] = [
  { id: 'dashboard', label: 'Inicio',      icon: <LayoutDashboard className="w-5 h-5" /> },
  { id: 'inventory', label: 'Items',       icon: <Package          className="w-5 h-5" /> },
  { id: 'orders',    label: 'Pedidos',     icon: <ShoppingBag      className="w-5 h-5" /> },
  { id: 'profits',   label: 'Beneficios',  icon: <TrendingUp       className="w-5 h-5" /> },
];

const MOBILE_MORE: { id: Page; label: string; icon: React.ReactNode }[] = [
  { id: 'tongue',   label: 'Lengüeta', icon: <Scissors className="w-5 h-5" /> },
  { id: 'photos',   label: 'Fantasma', icon: <Ghost    className="w-5 h-5" /> },
  { id: 'accounts', label: 'Cuentas',  icon: <Users    className="w-5 h-5" /> },
  { id: 'boost',    label: 'Boost',    icon: <Zap      className="w-5 h-5" /> },
  { id: 'settings', label: 'Config',   icon: <Settings className="w-5 h-5" /> },
];

export function MobileTabBar({
  currentPage, onNavigate, allowedPages,
}: {
  currentPage: Page;
  onNavigate: (p: Page) => void;
  allowedPages: Set<Page>;
}) {
  const [showMore, setShowMore] = useState(false);
  const inMore = MOBILE_MORE.some(i => i.id === currentPage);

  return (
    <>
      {/* "Más" bottom sheet */}
      <AnimatePresence>
        {showMore && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="lg:hidden fixed inset-0 z-40 bg-black/60"
              onClick={() => setShowMore(false)}
            />
            <motion.div
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 32, stiffness: 320 }}
              className="lg:hidden fixed bottom-[60px] left-0 right-0 z-50 bg-[#141414] border-t border-white/[0.08] rounded-t-3xl p-4 pb-2"
            >
              <div className="w-8 h-1 bg-white/15 rounded-full mx-auto mb-4" />
              <div className="grid grid-cols-5 gap-1 mb-2">
                {MOBILE_MORE.map(item => {
                  const active  = currentPage === item.id;
                  const locked  = !allowedPages.has(item.id);
                  return (
                    <button key={item.id} onClick={() => { onNavigate(item.id); setShowMore(false); }}
                      className={`relative flex flex-col items-center gap-1.5 p-3 rounded-2xl transition-all ${
                        locked   ? 'text-[#333330]' :
                        active   ? 'bg-[#d4ff00]/10 text-[#d4ff00]' :
                        'text-[#888880] hover:text-[#f2f2ef] hover:bg-white/[0.04]'
                      }`}>
                      {item.icon}
                      <span className={`text-[10px] font-medium text-center leading-tight ${locked ? 'opacity-30' : ''}`}>{item.label}</span>
                      {locked && <Lock className="absolute top-1.5 right-1.5 w-2.5 h-2.5 text-[#444440]" />}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Bottom tab bar */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-[rgba(10,10,10,0.95)] backdrop-blur-xl border-t border-white/[0.08]">
        <div className="flex items-center justify-around px-1 py-2 pb-[max(8px,env(safe-area-inset-bottom))]">
          {MOBILE_MAIN.map(item => {
            const active = currentPage === item.id;
            const locked = !allowedPages.has(item.id);
            return (
              <button key={item.id} onClick={() => { onNavigate(item.id); setShowMore(false); }}
                className={`relative flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-all ${
                  locked ? 'text-[#333330]' : active ? 'text-[#d4ff00]' : 'text-[#555550]'
                }`}>
                {item.icon}
                <span className="text-[9px] font-medium uppercase tracking-wider">{item.label}</span>
                {locked && <Lock className="absolute top-0.5 right-0.5 w-2 h-2 text-[#444440]" />}
              </button>
            );
          })}
          {/* Más */}
          <button onClick={() => setShowMore(v => !v)}
            className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-all ${(showMore || inMore) ? 'text-[#d4ff00]' : 'text-[#555550]'}`}>
            {showMore ? <X className="w-5 h-5" /> : <MoreHorizontal className="w-5 h-5" />}
            <span className="text-[9px] font-medium uppercase tracking-wider">Más</span>
          </button>
        </div>
      </nav>
    </>
  );
}
