import React from 'react';
import { motion } from 'motion/react';
import { Key, User, LogOut, CheckCircle2, AlertCircle, Clock } from 'lucide-react';

interface SettingsPageProps {
  token: string;
  user: { username: string; email: string; is_admin?: boolean };
  license: {
    key: string;
    type: string;
    expires_at: string | null;
    status?: string;
  } | null;
  onLogout: () => void;
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-[#161616] border border-white/[0.06] rounded-2xl overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-4 border-b border-white/[0.06]">
        <span className="text-[#888880]">{icon}</span>
        <p className="text-[0.85rem] font-semibold text-[#f2f2ef]">{title}</p>
      </div>
      <div className="p-5 space-y-4">{children}</div>
    </div>
  );
}

function FieldRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-b border-white/[0.04] last:border-0">
      <span className="text-[0.78rem] text-[#888880] shrink-0">{label}</span>
      <span className={`text-[0.85rem] text-[#f2f2ef] text-right ${mono ? 'font-mono' : 'font-medium'} truncate max-w-[60%]`}>
        {value}
      </span>
    </div>
  );
}

export default function SettingsPage({ token, user, license, onLogout }: SettingsPageProps) {
  const isExpired = license?.expires_at ? new Date(license.expires_at) < new Date() : false;
  const expiresLabel = license?.expires_at
    ? new Date(license.expires_at).toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' })
    : 'Sin expiración';

  const planLabel: Record<string, string> = {
    basic:   'Basic',
    pro:     'Pro',
    elite:   'Elite',
    lifetime:'Lifetime',
  };

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <p className="font-display text-[0.75rem] tracking-[0.3em] text-[#d4ff00]">CUENTA</p>
        <h1 className="font-display text-[2.4rem] leading-none tracking-[0.02em] text-[#f2f2ef] mt-1">Configuración</h1>
      </div>

      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
        {/* Licencia */}
        <Section title="Licencia" icon={<Key className="w-4 h-4" />}>
          {license ? (
            <>
              <FieldRow label="Clave" value={license.key} mono />
              <FieldRow
                label="Plan"
                value={
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#d4ff00]/10 text-[#d4ff00] border border-[#d4ff00]/20">
                    {planLabel[license.type] || license.type || 'Desconocido'}
                  </span>
                }
              />
              <FieldRow
                label="Estado"
                value={
                  isExpired ? (
                    <span className="inline-flex items-center gap-1.5 text-[#ff8080]">
                      <AlertCircle className="w-3.5 h-3.5" /> Expirada
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-[#d4ff00]">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Activa
                    </span>
                  )
                }
              />
              <FieldRow
                label="Expira"
                value={
                  <span className="inline-flex items-center gap-1.5 text-[#888880]">
                    <Clock className="w-3.5 h-3.5" /> {expiresLabel}
                  </span>
                }
              />
            </>
          ) : (
            <div className="flex items-center gap-2 text-[#888880]">
              <AlertCircle className="w-4 h-4 text-[#ff8080]" />
              <span className="text-[0.85rem]">Sin licencia activa</span>
            </div>
          )}
        </Section>

        {/* Sesión */}
        <Section title="Sesión" icon={<User className="w-4 h-4" />}>
          <FieldRow label="Usuario"    value={user.username} />
          <FieldRow label="Email"      value={user.email} mono />
          {user.is_admin && (
            <FieldRow
              label="Rol"
              value={
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#ffcc55]/10 text-[#ffcc55] border border-[#ffcc55]/20">
                  Administrador
                </span>
              }
            />
          )}
          <div className="pt-2">
            <button
              onClick={onLogout}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-[#ff8080]/20 text-[#ff8080] text-[0.82rem] font-medium hover:bg-[#ff8080]/[0.06] transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Cerrar sesión
            </button>
          </div>
        </Section>
      </motion.div>
    </div>
  );
}
