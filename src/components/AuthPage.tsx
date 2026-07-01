import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Lock, Mail, Eye, EyeOff, AlertCircle } from 'lucide-react';

interface AuthPageProps {
  onAuth: (token: string, user: any) => void;
}

export default function AuthPage({ onAuth }: AuthPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      localStorage.setItem('fc_token', data.token);
      onAuth(data.token, data.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 28 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-[540px]"
      >
        {/* Auth shell — estilo /hub */}
        <section className="relative border border-white/[0.16] rounded-[28px] overflow-hidden shadow-[0_40px_110px_rgba(0,0,0,0.55)]"
          style={{ background: 'linear-gradient(180deg, rgba(18, 22, 24, 0.94) 0%, rgba(10, 12, 14, 0.94) 100%)' }}>
          {/* Acid radial overlay */}
          <div className="absolute inset-0 pointer-events-none opacity-70" style={{
            background: 'radial-gradient(circle at 100% 0%, rgba(77, 159, 255, 0.16), transparent 48%), radial-gradient(circle at 0% 110%, rgba(77, 159, 255, 0.06), transparent 42%)',
          }} />

          <div className="relative z-10 px-[34px] pt-9 pb-7">
            {/* Header */}
            <div className="grid gap-2.5 mb-5">
              <p className="font-display text-[0.8rem] tracking-[0.3em] text-acid m-0">CENTRO DE CLIENTES</p>
              <h1 className="font-display m-0 text-[clamp(2.6rem,5vw,3.6rem)] leading-[0.96] tracking-[0.02em] text-[var(--color-text)]">
                Login
              </h1>
              <p className="text-[0.95rem] leading-[1.65] text-muted m-0">
                Inicia sesión para gestionar tus módulos del Hub con una sola cuenta.
              </p>
            </div>

            <form onSubmit={submit} className="grid gap-3.5">

              <label className="grid gap-2">
                <span className="text-[0.78rem] tracking-[0.18em] uppercase text-muted-strong font-bold">Correo</span>
                <div className="relative">
                  <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="tu@email.com"
                    required
                    autoComplete="email"
                    className="w-full min-h-[50px] rounded-[14px] border border-white/[0.16] bg-black/[0.28] text-[var(--color-text)] pl-11 pr-4 outline-none transition ease-hub hover:border-white/[0.22] focus:border-acid focus:bg-black/40 focus:shadow-[0_0_0_3px_rgba(77,159,255,0.12)]"
                  />
                </div>
              </label>

              <label className="grid gap-2">
                <span className="text-[0.78rem] tracking-[0.18em] uppercase text-muted-strong font-bold">Contraseña</span>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    autoComplete="current-password"
                    className="w-full min-h-[50px] rounded-[14px] border border-white/[0.16] bg-black/[0.28] text-[var(--color-text)] pl-11 pr-12 outline-none transition ease-hub hover:border-white/[0.22] focus:border-acid focus:bg-black/40 focus:shadow-[0_0_0_3px_rgba(77,159,255,0.12)]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(p => !p)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-[var(--color-text)] transition"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </label>

              {error && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex items-center gap-2 border rounded-[14px] px-3.5 py-2.5 text-[0.88rem]"
                  style={{ background: 'rgba(255,151,151,0.08)', borderColor: 'rgba(255,151,151,0.38)', color: 'var(--color-danger)' }}
                >
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {error}
                </motion.div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="min-h-[50px] rounded-full border-none bg-acid-gradient text-[#0a0d10] font-bold tracking-[0.02em] px-6 shadow-acid transition ease-hub hover:-translate-y-0.5 hover:shadow-acid-lg disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none"
              >
                {loading ? 'Cargando…' : 'Entrar'}
              </button>
            </form>
          </div>
        </section>

        <p className="text-center text-xs text-muted mt-5">
          FounderClub © {new Date().getFullYear()} — Uso personal
        </p>
      </motion.div>
    </div>
  );
}
