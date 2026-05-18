import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Lock, User, Mail, Eye, EyeOff, AlertCircle } from 'lucide-react';

interface AuthPageProps {
  onAuth: (token: string, user: any) => void;
}

export default function AuthPage({ onAuth }: AuthPageProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
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
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = mode === 'login' ? { email, password } : { username, email, password };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-[480px] relative z-10"
      >
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-4">
            <div
              className="w-3 h-3 rounded-[3px] bg-[#4d9fff]"
              style={{ boxShadow: '0 0 20px rgba(77,159,255,0.55)' }}
            />
            <span className="text-2xl font-bold tracking-tight text-[#f4f4ef]">FounderClub</span>
          </div>
          <p className="text-[#a4a79f] text-sm">Herramientas profesionales para Vinted</p>
        </div>

        {/* Card */}
        <div
          className="border rounded-[28px] p-8 relative overflow-hidden"
          style={{
            background: 'linear-gradient(180deg, rgba(18,22,24,0.94) 0%, rgba(10,12,14,0.94) 100%)',
            borderColor: 'rgba(255,255,255,0.16)',
            boxShadow: '0 40px 110px rgba(0,0,0,0.55)',
          }}
        >
          {/* Inner glow */}
          <div
            className="absolute inset-0 rounded-[28px] pointer-events-none"
            style={{
              background: 'radial-gradient(circle at 100% 0%, rgba(77,159,255,0.16), transparent 48%), radial-gradient(circle at 0% 110%, rgba(77,159,255,0.06), transparent 42%)',
              opacity: 0.7,
            }}
          />

          <div className="relative z-10">
            {/* Tabs */}
            <div className="flex border-b border-white/8 mb-6">
              {(['login', 'register'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => { setMode(tab); setError(null); }}
                  className={`flex-1 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${
                    mode === tab
                      ? 'border-[#4d9fff] text-[#f4f4ef]'
                      : 'border-transparent text-[#a4a79f] hover:text-[#f4f4ef]'
                  }`}
                >
                  {tab === 'login' ? 'Iniciar sesión' : 'Registrarse'}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="space-y-4">
              <AnimatePresence mode="wait">
                {mode === 'register' && (
                  <motion.div
                    key="username"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <label className="block text-[10px] font-bold uppercase tracking-[0.18em] text-[#b8bab2] mb-1.5">Usuario</label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#a4a79f]" />
                      <input
                        type="text"
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        placeholder="tunombre"
                        required
                        className="w-full bg-[#111416] border border-white/8 rounded-[14px] pl-10 pr-4 py-3 text-sm text-[#f4f4ef] placeholder-[#a4a79f] focus:outline-none focus:border-[#4d9fff]/35 focus:shadow-[0_0_0_3px_rgba(77,159,255,0.12)] transition-all"
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div>
                <label className="block text-[10px] font-bold uppercase tracking-[0.18em] text-[#b8bab2] mb-1.5">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#a4a79f]" />
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="tu@email.com"
                    required
                    className="w-full bg-[#111416] border border-white/8 rounded-[14px] pl-10 pr-4 py-3 text-sm text-[#f4f4ef] placeholder-[#a4a79f] focus:outline-none focus:border-[#4d9fff]/35 focus:shadow-[0_0_0_3px_rgba(77,159,255,0.12)] transition-all"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold uppercase tracking-[0.18em] text-[#b8bab2] mb-1.5">Contraseña</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#a4a79f]" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    className="w-full bg-[#111416] border border-white/8 rounded-[14px] pl-10 pr-10 py-3 text-sm text-[#f4f4ef] placeholder-[#a4a79f] focus:outline-none focus:border-[#4d9fff]/35 focus:shadow-[0_0_0_3px_rgba(77,159,255,0.12)] transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(p => !p)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#a4a79f] hover:text-[#f4f4ef] transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex items-center gap-2 rounded-[14px] px-3 py-2.5 text-sm text-[#ff9797] border"
                  style={{
                    background: 'rgba(255,151,151,0.08)',
                    borderColor: 'rgba(255,151,151,0.2)',
                  }}
                >
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {error}
                </motion.div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-[#4d9fff] hover:bg-[#3b7fd4] disabled:opacity-50 disabled:cursor-not-allowed text-[#050607] font-bold rounded-[14px] py-3 text-sm transition-all"
                style={{ boxShadow: '0 18px 40px -12px rgba(77,159,255,0.45)' }}
              >
                {loading ? 'Cargando...' : mode === 'login' ? 'Entrar' : 'Crear cuenta'}
              </button>
            </form>
          </div>
        </div>

        <p className="text-center text-xs text-[#a4a79f]/50 mt-4">
          FounderClub &copy; {new Date().getFullYear()} — Uso personal
        </p>
      </motion.div>
    </div>
  );
}
