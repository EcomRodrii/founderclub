import React, { useState, useEffect } from 'react';
import { CheckCircle2, RefreshCcw, Copy, Check, ChevronRight, ChevronLeft, Clock } from 'lucide-react';

type Status = 'loading' | 'none' | 'submitted' | 'plan_ready';

const STEPS = [
  {
    title: 'Tu situación actual',
    qs: [
      { key: 'q1', label: '¿En qué punto estás ahora mismo con la reventa?', placeholder: 'Cuéntame desde dónde partes, cuánto llevas, qué has probado…' },
      { key: 'q2', label: 'Facturación mensual', placeholder: 'Tu media mensual y tu mejor mes…' },
      { key: 'q3', label: '¿Qué estás vendiendo?', placeholder: 'Tipos de producto, marcas, rangos de precio…' },
    ],
  },
  {
    title: 'Stock y proveedores',
    qs: [
      { key: 'q4', label: 'Proveedores y precios', placeholder: 'De dónde sacas el stock, precios de coste aproximados…' },
      { key: 'q5', label: 'Organización del stock', placeholder: 'Cómo lo tienes organizado, dónde lo almacenas…' },
      { key: 'q6', label: '¿Compras stock por semana o mes?', placeholder: 'Frecuencia de compra y volumen…' },
    ],
  },
  {
    title: 'Multicuentas — Operativa',
    qs: [
      { key: 'q8', label: 'Número de cuentas de Vinted activas', placeholder: 'Cuántas tienes activas y cómo las gestionas…' },
      { key: 'q7', label: '¿Sabes gestionar incidencias en envíos?', placeholder: 'Qué haces cuando hay problemas con envíos…' },
      { key: 'q9', label: '¿Sabes detectar shadowban?', placeholder: 'Cómo lo detectas, qué señales buscas…' },
      { key: 'q10', label: '¿Sabes detectar lista negra?', placeholder: 'Cómo sabes si un producto está en lista negra…' },
      { key: 'q12', label: 'Método de creación de cuentas', placeholder: 'Cómo creas las cuentas, qué dispositivos usas…' },
    ],
  },
  {
    title: 'Multicuentas — Control',
    qs: [
      { key: 'q13', label: 'Estabilidad de cuentas', placeholder: 'Cuánto duran, qué porcentaje se bloquea…' },
      { key: 'q14', label: 'Interpretación de bloqueos', placeholder: 'Cuando te bloquean, a qué lo atribuyes…' },
      { key: 'q15', label: 'Control del proceso de maduración', placeholder: 'Cómo maduras una cuenta nueva…' },
      { key: 'q31', label: 'Diagnóstico de bloqueos', placeholder: 'Cómo analizas por qué te han bloqueado…' },
      { key: 'q40', label: 'Criterios para madurar una cuenta', placeholder: 'Qué tiene que cumplir una cuenta para considerarla madura…' },
    ],
  },
  {
    title: 'Productos',
    qs: [
      { key: 'q16', label: 'Búsqueda de productos', placeholder: 'Cómo encuentras qué vender…' },
      { key: 'q17', label: 'Decisión de escalar producto', placeholder: 'Cuándo decides escalar y cuánto…' },
      { key: 'q18', label: 'Gestión de productos en revisión (REPS)', placeholder: 'Qué haces cuando un producto está en revisión…' },
      { key: 'q19', label: 'Proceso desde compra hasta venta', placeholder: 'Cuéntame el proceso completo…' },
      { key: 'q20', label: 'Testeo de producto nuevo', placeholder: 'Cuántas unidades testeas, en qué cuentas…' },
      { key: 'q21', label: 'Criterios para invertir más', placeholder: 'Qué tiene que pasar para invertir más en un producto…' },
    ],
  },
  {
    title: 'Números y publicación',
    qs: [
      { key: 'q22', label: 'Margen medio por producto', placeholder: 'Qué margen sacas de media por par…' },
      { key: 'q23', label: 'Volumen vs margen', placeholder: 'Priorizas volumen o margen, y por qué…' },
      { key: 'q24', label: '% vendido en primera semana', placeholder: 'Qué porcentaje del stock nuevo vendes en la primera semana…' },
      { key: 'q25', label: 'Publicaciones por cuenta al día', placeholder: 'Cuántos artículos publicas por cuenta…' },
      { key: 'q26', label: 'Método de publicación', placeholder: 'Cómo publicas, qué proceso sigues…' },
      { key: 'q27', label: 'Estrategia con reps', placeholder: 'Metes normales antes de subir reps, cómo lo gestionas…' },
      { key: 'q28', label: '% stock parado más de 15 días', placeholder: 'Qué porcentaje lleva más de 15 días sin venderse…' },
      { key: 'q29', label: 'Acción con producto estancado', placeholder: 'Qué haces cuando un producto no se mueve…' },
      { key: 'q30', label: 'Control de beneficios y números', placeholder: 'Cómo llevas el control de tus números…' },
    ],
  },
  {
    title: 'Mentalidad y objetivos',
    qs: [
      { key: 'q32', label: 'Gestión de compradores difíciles', placeholder: 'Cómo manejas conflictos con compradores…' },
      { key: 'q33', label: 'Punto de mejora principal', placeholder: 'En qué crees que más puedes mejorar…' },
      { key: 'q34', label: 'Plan de recuperación desde cero', placeholder: 'Si mañana te quitaran todo, qué harías…' },
      { key: 'q35', label: 'Qué harías diferente empezando hoy', placeholder: 'Con lo que sabes ahora, qué cambiarías…' },
      { key: 'q36', label: 'Objetivo de facturación', placeholder: 'Cuánto quieres facturar y en qué plazo…' },
      { key: 'q37', label: 'Uso de la app', placeholder: 'Qué herramientas de la app usas y cómo te van…' },
      { key: 'q38', label: 'Error más caro cometido', placeholder: 'El error que más te ha costado, qué pasó…' },
      { key: 'q39', label: 'Escalado sin romper lo que funciona', placeholder: 'Cómo piensas escalar sin perder lo que ya funciona…' },
      { key: 'q11', label: 'Actividad adicional relacionada', placeholder: 'Tienes otras actividades relacionadas con la reventa…' },
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
  const progress = Math.round(((step) / totalSteps) * 100);

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

  // Loading
  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="w-5 h-5 rounded-full border-2 border-white/10 border-t-[#d4ff00]/60 animate-spin" />
      </div>
    );
  }

  // Plan ready
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
            Copiar para WhatsApp
          </button>
        </div>
        <div className="bg-white/[0.03] border border-white/[0.08] rounded-2xl p-5">
          <PlanRenderer plan={plan} />
        </div>
      </div>
    );
  }

  // Submitted / waiting
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

  // Form
  return (
    <div className="max-w-xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-lg font-bold text-[#f2f2ef]">Diagnóstico inicial</h1>
        <p className="text-[0.78rem] text-[#888880] mt-0.5">
          Responde con sinceridad — esto permite a Lamine crear tu plan 1:1 personalizado
        </p>
      </div>

      {/* Progress */}
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

      {/* Questions */}
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

      {/* Navigation */}
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
