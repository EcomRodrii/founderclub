import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Zap, Activity } from 'lucide-react';

interface BoostJob {
  id: number;
  status: string;
  created_at: string;
  account_login?: string;
  items_count?: number;
}

interface BoostStats {
  total: number;
  completed: number;
  pending: number;
  failed: number;
}

interface BoostPageProps {
  token: string;
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="bg-[#161616] border border-white/[0.06] rounded-2xl p-5">
      <p className="text-[0.72rem] font-medium uppercase tracking-widest text-[#888880] mb-3">{label}</p>
      <p className={`font-display text-[2rem] leading-none ${color || 'text-[#f2f2ef]'}`}>{value}</p>
    </div>
  );
}

function JobStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: 'bg-[#d4ff00]/10 text-[#d4ff00] border-[#d4ff00]/20',
    pending:   'bg-[#ffcc55]/10 text-[#ffcc55] border-[#ffcc55]/20',
    running:   'bg-[#d4ff00]/10 text-[#d4ff00] border-[#d4ff00]/20',
    failed:    'bg-[#ff8080]/10 text-[#ff8080] border-[#ff8080]/20',
  };
  const cls = map[status] || 'bg-white/5 text-white/40 border-white/10';
  return (
    <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold border capitalize ${cls}`}>
      {status}
    </span>
  );
}

export default function BoostPage({ token }: BoostPageProps) {
  const [jobs, setJobs] = useState<BoostJob[]>([]);
  const [stats, setStats] = useState<BoostStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [noPlan, setNoPlan] = useState(false);

  const authHeaders = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [jobsRes, statsRes] = await Promise.all([
          fetch('/api/boost/requests', { headers: authHeaders }),
          fetch('/api/boost/stats', { headers: authHeaders }),
        ]);

        const contentType = jobsRes.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          setNoPlan(true);
          setLoading(false);
          return;
        }

        const [jobsData, statsData] = await Promise.all([jobsRes.json(), statsRes.json()]);
        setJobs(Array.isArray(jobsData) ? jobsData : (jobsData.data || []));
        if (statsData.ok || statsData.total !== undefined) {
          setStats(statsData.data || statsData);
        }
      } catch {}
      setLoading(false);
    };
    load();
  }, [token]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="w-6 h-6 border-2 border-[#d4ff00] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (noPlan) {
    return (
      <div className="space-y-6">
        <div>
          <p className="font-display text-[0.75rem] tracking-[0.3em] text-[#d4ff00]">AUTOMATIZACIÓN</p>
          <h1 className="font-display text-[2.4rem] leading-none tracking-[0.02em] text-[#f2f2ef] mt-1">Boost</h1>
        </div>
        <div className="flex flex-col items-center justify-center h-64 border border-dashed border-[#d4ff00]/20 rounded-2xl text-center px-8 bg-[#d4ff00]/[0.02]">
          <div className="w-14 h-14 rounded-full bg-[#d4ff00]/10 border border-[#d4ff00]/20 flex items-center justify-center mb-4">
            <Zap className="w-7 h-7 text-[#d4ff00]" />
          </div>
          <p className="text-[0.95rem] font-semibold text-[#f2f2ef]">Función no disponible en tu plan</p>
          <p className="text-[0.82rem] text-[#888880] mt-1.5 max-w-sm">
            El módulo Boost automatiza la subida de artículos en Vinted. Requiere un plan con Boost habilitado.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="font-display text-[0.75rem] tracking-[0.3em] text-[#d4ff00]">AUTOMATIZACIÓN</p>
        <h1 className="font-display text-[2.4rem] leading-none tracking-[0.02em] text-[#f2f2ef] mt-1">Boost</h1>
      </div>

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Total jobs"    value={stats.total}     />
          <StatCard label="Completados"   value={stats.completed} color="text-[#d4ff00]" />
          <StatCard label="Pendientes"    value={stats.pending}   color="text-[#ffcc55]" />
          <StatCard label="Fallidos"      value={stats.failed}    color="text-[#ff8080]" />
        </div>
      )}

      <div className="bg-[#161616] border border-white/[0.06] rounded-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-white/[0.06]">
          <Activity className="w-4 h-4 text-[#888880]" />
          <p className="text-[0.85rem] font-semibold text-[#f2f2ef]">Historial de jobs</p>
          <span className="ml-auto text-[0.75rem] text-[#888880] bg-white/[0.05] px-2 py-0.5 rounded-full">{jobs.length}</span>
        </div>

        {jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-center">
            <Zap className="w-8 h-8 text-white/10 mb-3" />
            <p className="text-[0.85rem] text-[#888880]">Sin jobs de boost registrados</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  {['ID', 'Cuenta', 'Items', 'Estado', 'Fecha'].map(col => (
                    <th key={col} className="px-4 py-3 text-left text-[0.7rem] font-semibold uppercase tracking-widest text-[#888880]">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.map((job, idx) => (
                  <motion.tr
                    key={job.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: Math.min(idx * 0.02, 0.3) }}
                    className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-[0.78rem] text-[#888880]">#{job.id}</td>
                    <td className="px-4 py-3 text-[0.85rem] text-[#f2f2ef]">{job.account_login || '—'}</td>
                    <td className="px-4 py-3 text-[0.85rem] text-[#f2f2ef]">{job.items_count ?? '—'}</td>
                    <td className="px-4 py-3"><JobStatusBadge status={job.status} /></td>
                    <td className="px-4 py-3 text-[0.78rem] text-[#888880]">
                      {job.created_at
                        ? new Date(job.created_at).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit' })
                        : '—'}
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
