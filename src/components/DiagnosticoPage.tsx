import React, { useState, useEffect } from 'react';
import { CheckCircle2, RefreshCcw, Copy, Check, ChevronRight, ChevronLeft, Clock } from 'lucide-react';

type Status = 'loading' | 'none' | 'submitted' | 'plan_ready';

const STEPS = [
  {
    title: '¿Dónde estás ahora?',
    qs: [
      { key: 'q1', label: '¿Hace cuánto tiempo llevas vendiendo en Vinted?', placeholder: 'Ej: 2 meses, 6 meses, desde enero…' },
      { key: 'q2', label: '¿Cuánto estás facturando de media al mes?', placeholder: 'Aproximado está bien, sin presión' },
      { key: 'q3', label: '¿Con cuántas cuentas de Vinted trabajas actualmente?', placeholder: 'Cuántas tienes y cuántas usas de verdad' },
    ],
  },
  {
    title: 'Tu producto y stock',
    qs: [
      { key: 'q4', label: '¿Qué tipo de zapatillas vendes?', placeholder: 'Marcas, modelos, rangos de precio, nuevas o segunda mano…' },
      { key: 'q5', label: '¿De dónde consigues el stock y a qué precio lo compras?', placeholder: 'Cómo encuentras los productos, dónde los compras…' },
      { key: 'q6', label: '¿Cuánto tardas de media en vender un par desde que lo publicas?', placeholder: 'Días, semanas… y si varía mucho entre productos' },
    ],
  },
  {
    title: 'Cómo lo haces',
    qs: [
      { key: 'q7', label: 'Cuéntame tu proceso completo: desde que compras hasta que vendes', placeholder: 'Fotos, publicación, precio, gestión de mensajes, envíos…' },
      { key: 'q8', label: '¿Has tenido bloqueos de cuentas? Si es así, ¿a qué crees que se deben?', placeholder: 'Si no has tenido, cuéntame cómo los evitas o por qué crees que no los tienes…' },
      { key: 'q9', label: '¿Qué haces cuando un producto lleva más de 2 semanas sin venderse?', placeholder: 'Tu estrategia actual con el stock parado…' },
    ],
  },
  {
    title: 'Tus problemas y objetivos',
    qs: [
      { key: 'q10', label: '¿Cuál es el mayor problema o bloqueo que tienes ahora mismo?', placeholder: 'Lo que más te frena, lo que no consigues resolver o lo que más te preocupa…' },
      { key: 'q11', label: '¿Qué has intentado para solucionarlo y no ha funcionado?', placeholder: 'Sé honesto, esto ayuda a Lamine a entenderte de verdad…' },
      { key: 'q12', label: '¿Cuánto quieres ganar al mes y en qué plazo?', placeholder: 'Tu objetivo concreto: número y fecha…' },
      { key: 'q13', label: '¿Hay algo más que quieras contarle a Lamine sobre tu situación?', placeholder: 'Cualquier contexto que creas importante y no hayas contado…' },
    ],
  },
];

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className={`shrink-0 p-1.5 rounded-lg transition ${copied ? 'text-green-400' : 'text-zinc-500 hover:text-zinc-300'}`}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function PlanRenderer({ plan }: { plan: string }) {
  return (
    <div className="space-y-3">
      {plan.split('\n').map((line, i) => {
        if (line.startsWith('## ')) {
          return <h3 key={i} className="text-sm font-bold text-white mt-6 first:mt-0">{line.replace('## ', '')}</h3>;
        }
        if (/^\*\*Punto \d/.test(line)) {
          return <p key={i} className="text-xs font-bold text-violet-300 mt-3 uppercase tracking-wide">{line.replace(/\*\*/g, '')}</p>;
        }
        if (line.trim() === '---') return <hr key={i} className="border-zinc-800 my-2" />;
        if (line.trim() === '') return <div key={i} className="h-1" />;
        const parts = line.split(/\*\*(.+?)\*\*/g);
        const rendered = parts.map((p, j) => j % 2 === 1 ? <strong key={j} className="text-white font-semibold">{p}</strong> : p);
        const isBullet = /^[\s]*[•\-\*] /.test(line);
        const isWhatsapp = line.includes('📲') || line.includes('mensaje para Lamine');
        if (isWhatsapp) return <p key={i} className="text-sm leading-relaxed text-amber-300/90 italic">{rendered}</p>;
        if (isBullet) return (
          <div key={i} className="flex gap-2 text-sm leading-relaxed text-zinc-300">
            <span className="text-violet-400 shrink-0 mt-0.5">•</span>
            <span>{parts.map((p, j) => j % 2 === 1 ? <strong key={j} className="text-white">{p}</strong> : p.replace(/^[\s•\-\*]+/, ''))}</span>
          </div>
        );
        return <p key={i} className="text-sm leading-relaxed text-zinc-300">{rendered}</p>;
      })}
    </div>
  );
}

export default function DiagnosticoPage({ token }: { token: string }) {
  const [status, setStatus] = useState<Status>('loading');
  const [plan, setPlan] = useState<string | null>(null);
  const [planDate, setPlanDate] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/diagnostic/mine', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        if (data.status === 'plan_ready') { setStatus('plan_ready'); setPlan(data.plan); setPlanDate(data.plan_generated_at); }
        else if (data.status === 'submitted') setStatus('submitted');
        else setStatus('none');
      })
      .catch(() => setStatus('none'));
  }, [token]);

  const currentStep = STEPS[step];
  const totalSteps = STEPS.length;
  const progress = Math.round((step / totalSteps) * 100);
  const stepComplete = currentStep.qs.every(q => (answers[q.key] || '').trim().length > 0);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch('/api/diagnostic/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ answers }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Error al enviar');
      setStatus('submitted');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const copyPlanForWhatsApp = () => {
    if (!plan) return;
    const plain = plan
      .replace(/^## (.+)$/gm, '\n$1\n')
      .replace(/^\*\*(.+?)\*\*$/gm, '$1')
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/^[•\-\*] /gm, '• ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    navigator.clipboard.writeText(plain);
  };

  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="w-5 h-5 rounded-full border-2 border-white/10 border-t-[#d4ff00]/60 animate-spin" />
      </div>
    );
  }

  if (status === 'plan_ready' && plan) {
    return (
      <div className="max-w-2xl mx-auto space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-lg font-bold text-[#f2f2ef]">Tu plan de mejora</h1>
            {planDate && (
              <p className="text-xs text-[#888880] mt-0.5">
                Generado el {new Date(planDate).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}
              </p>
            )}
          </div>
          <button
            onClick={copyPlanForWhatsApp}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600/20 border border-green-500/30 text-green-400 text-xs font-semibold hover:bg-green-600/35 transition shrink-0"
          >
            📋 Copiar para WhatsApp
          </button>
        </div>
        <div className="bg-white/[0.03] border border-white/[0.08] rounded-2xl p-5">
          <PlanRenderer plan={plan} />
        </div>
      </div>
    );
  }

  if (status === 'submitted') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[55vh] gap-5 text-center px-4">
        <div className="w-14 h-14 rounded-2xl bg-[#d4ff00]/10 border border-[#d4ff00]/25 flex items-center justify-center">
          <Clock className="w-7 h-7 text-[#d4ff00]" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-[#f2f2ef]">Diagnóstico enviado</h2>
          <p className="text-[#888880] mt-2 max-w-xs leading-relaxed text-sm">
            Lamine está revisando tus respuestas y preparando tu plan personalizado. Te avisará cuando esté listo.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto space-y-5">
      <div>
        <h1 className="text-lg font-bold text-[#f2f2ef]">Diagnóstico inicial</h1>
        <p className="text-[0.78rem] text-[#888880] mt-0.5">
          Responde con sinceridad — esto permite a Lamine crear tu plan 1:1 personalizado
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between text-xs text-[#888880] mb-2">
          <span>{currentStep.title}</span>
          <span>{step + 1} / {totalSteps}</span>
        </div>
        <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
          <div
            className="h-full bg-[#d4ff00] rounded-full transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div className="space-y-4">
        {currentStep.qs.map(q => (
          <div key={q.key}>
            <label className="block text-sm font-medium text-[#f2f2ef] mb-1.5">{q.label}</label>
            <textarea
              value={answers[q.key] || ''}
              onChange={e => setAnswers(prev => ({ ...prev, [q.key]: e.target.value }))}
              placeholder={q.placeholder}
              rows={3}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-[#f2f2ef] placeholder-[#444440] focus:outline-none focus:border-[#d4ff00]/40 transition resize-none"
            />
          </div>
        ))}
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-3 text-sm text-red-400">{error}</div>
      )}

      <div className="flex gap-3">
        {step > 0 && (
          <button
            onClick={() => setStep(s => s - 1)}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-white/[0.08] text-[#888880] hover:text-[#f2f2ef] text-sm font-semibold transition"
          >
            <ChevronLeft className="w-4 h-4" /> Anterior
          </button>
        )}
        {step < totalSteps - 1 ? (
          <button
            onClick={() => setStep(s => s + 1)}
            disabled={!stepComplete}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-bold text-black bg-[#d4ff00] hover:bg-[#c8f000] disabled:opacity-30 transition text-sm"
          >
            Siguiente <ChevronRight className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!stepComplete || submitting}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl font-bold text-black bg-[#d4ff00] hover:bg-[#c8f000] disabled:opacity-30 transition text-sm"
          >
            {submitting ? <><RefreshCcw className="w-4 h-4 animate-spin" /> Enviando…</> : <><CheckCircle2 className="w-4 h-4" /> Enviar diagnóstico</>}
          </button>
        )}
      </div>
    </div>
  );
}
