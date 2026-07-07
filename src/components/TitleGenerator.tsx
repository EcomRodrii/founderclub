import React, { useState, useRef } from 'react';
import {
  Camera, Pencil, Copy, Check, RefreshCcw,
  ChevronDown, ChevronUp, AlertCircle, CheckCircle2, X,
} from 'lucide-react';

type InputMode = 'photo' | 'manual';
type Lang = 'es' | 'fr' | 'en';

interface Result {
  identified: { brand: string; model: string; color: string; gender: string };
  code: string;
  titles: string[];
  descriptions: string[];
}

const BRAND_GUIDES = [
  {
    brand: 'Adidas',
    icon: '🟠',
    where: 'En la lengüeta (tongue) del zapato.',
    format: 'Letras + 5 dígitos',
    example: 'JQ5874, IF1234',
  },
  {
    brand: 'New Balance',
    icon: '🟡',
    where: 'Etiqueta interior del talón o lengüeta.',
    format: 'Letras + números (puede incluir color)',
    example: 'ML574LB, U998GB',
  },
  {
    brand: 'Onitsuka Tiger',
    icon: '⭕',
    where: 'Etiqueta interior lateral del zapato.',
    format: 'Número + letra + número',
    example: '1183A204, 1183B563',
  },
  {
    brand: 'Asics',
    icon: '🔵',
    where: 'Etiqueta interior del talón.',
    format: 'Número alfanumérico',
    example: '1011B295, 1012A234',
  },
];

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className={`shrink-0 p-1.5 rounded-lg transition ${copied ? 'text-green-400' : 'text-zinc-500 hover:text-zinc-300'}`}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

export default function TitleGenerator({ token }: { token: string }) {
  const [mode, setMode] = useState<InputMode>('photo');
  const [lang, setLang] = useState<Lang>('es');
  const [codeInput, setCodeInput] = useState('');
  const [imageFile, setImageFile] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const canGenerate = mode === 'photo' ? !!imageFile : codeInput.trim().length >= 4;

  const generate = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const body: Record<string, string> = { lang };
      if (mode === 'photo') body.imageBase64 = imageFile!;
      else body.code = codeInput.trim().toUpperCase();

      const r = await fetch('/api/titles/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Error generando contenido');
      setResult(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const langLabels: Record<Lang, string> = { es: 'Español', fr: 'Français', en: 'English' };
  const langFlags: Record<Lang, string> = { es: '🇪🇸', fr: '🇫🇷', en: '🇬🇧' };

  return (
    <div className="max-w-xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-lg font-bold text-[#f2f2ef]">Títulos y descripciones IA</h1>
        <p className="text-[0.78rem] text-[#888880] mt-0.5">
          Genera títulos SEO y descripciones listas para publicar en Vinted
        </p>
      </div>

      {/* Mode selector */}
      <div className="flex gap-2">
        {([['photo', '📷 Foto lengüeta'], ['manual', '✏️ Código manual']] as [InputMode, string][]).map(([id, label]) => (
          <button
            key={id}
            onClick={() => { setMode(id); setResult(null); setError(null); }}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold border transition ${
              mode === id
                ? 'bg-[#d4ff00]/10 border-[#d4ff00]/40 text-[#d4ff00]'
                : 'bg-white/[0.04] border-white/[0.08] text-[#888880] hover:text-[#f2f2ef]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Input area */}
      <div className="space-y-3">
        {mode === 'photo' ? (
          <>
            <div className="flex items-start gap-2.5 bg-yellow-500/[0.08] border border-yellow-500/20 rounded-xl px-3.5 py-2.5">
              <AlertCircle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
              <p className="text-[0.76rem] text-yellow-300 leading-relaxed">
                El código debe leerse <strong>completo y sin cortes</strong> en la foto. Buena luz, buen ángulo.
              </p>
            </div>

            <div
              onClick={() => fileRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition ${
                imageFile
                  ? 'border-[#d4ff00]/30 bg-[#d4ff00]/5'
                  : 'border-white/[0.1] hover:border-white/20'
              }`}
            >
              {imageFile ? (
                <div className="space-y-2">
                  <img src={imageFile} className="max-h-44 mx-auto rounded-lg object-contain" alt="lengüeta" />
                  <div className="flex items-center justify-center gap-2">
                    <p className="text-xs text-[#888880]">Toca para cambiar</p>
                    <button
                      onClick={e => { e.stopPropagation(); setImageFile(null); }}
                      className="text-zinc-600 hover:text-red-400 transition"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2 py-3">
                  <Camera className="w-8 h-8 text-[#444440] mx-auto" />
                  <p className="text-sm text-[#888880]">Sube foto de la lengüeta</p>
                  <p className="text-xs text-[#444440]">JPEG · PNG · HEIC</p>
                </div>
              )}
              <input
                type="file"
                ref={fileRef}
                accept="image/*"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onloadend = () => setImageFile(reader.result as string);
                  reader.readAsDataURL(file);
                  e.target.value = '';
                }}
              />
            </div>
          </>
        ) : (
          <div>
            <label className="block text-xs text-[#888880] mb-1.5">Código del modelo</label>
            <input
              type="text"
              value={codeInput}
              onChange={e => setCodeInput(e.target.value.toUpperCase())}
              placeholder="Ej: JQ5874"
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-[#f2f2ef] text-center text-lg font-mono tracking-widest placeholder-[#444440] focus:outline-none focus:border-[#d4ff00]/40 transition"
            />
          </div>
        )}

        {/* Brand guide */}
        <button
          onClick={() => setShowGuide(v => !v)}
          className="flex items-center gap-1.5 text-xs text-[#888880] hover:text-[#f2f2ef] transition"
        >
          {showGuide ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          ¿Dónde encuentro el código?
        </button>
        {showGuide && (
          <div className="grid gap-2">
            {BRAND_GUIDES.map(g => (
              <div key={g.brand} className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3">
                <p className="text-sm font-semibold mb-0.5 text-[#f2f2ef]">{g.icon} {g.brand}</p>
                <p className="text-xs text-[#888880]">{g.where}</p>
                <p className="text-xs text-[#555550] mt-0.5">
                  Formato: {g.format} — <span className="font-mono text-[#777770]">{g.example}</span>
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Language selector */}
      <div>
        <p className="text-xs text-[#888880] mb-2">Idioma del listado</p>
        <div className="flex gap-2">
          {(['es', 'fr', 'en'] as Lang[]).map(l => (
            <button
              key={l}
              onClick={() => setLang(l)}
              className={`flex-1 py-2 rounded-xl text-sm font-semibold border transition ${
                lang === l
                  ? 'bg-[#d4ff00]/10 border-[#d4ff00]/40 text-[#d4ff00]'
                  : 'bg-white/[0.04] border-white/[0.08] text-[#888880] hover:text-[#f2f2ef]'
              }`}
            >
              {langFlags[l]} {langLabels[l]}
            </button>
          ))}
        </div>
      </div>

      {/* Generate */}
      <button
        onClick={generate}
        disabled={!canGenerate || loading}
        className="w-full py-3 rounded-xl font-bold text-black bg-[#d4ff00] hover:bg-[#c8f000] disabled:opacity-30 transition flex items-center justify-center gap-2"
      >
        {loading
          ? <><RefreshCcw className="w-4 h-4 animate-spin" /> Generando…</>
          : '✨ Generar títulos y descripciones'
        }
      </button>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* Identified */}
          <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3">
            <p className="text-xs text-[#888880] mb-1">Modelo identificado</p>
            <p className="text-sm font-semibold text-[#f2f2ef]">
              {result.identified.brand} {result.identified.model} {result.identified.color}
              <span className="ml-2 text-xs font-normal text-[#888880]">· {result.identified.gender}</span>
            </p>
            {result.code && (
              <p className="text-xs text-[#555550] font-mono mt-0.5">Ref: {result.code}</p>
            )}
          </div>

          {/* Titles */}
          <div>
            <p className="text-xs font-bold text-[#888880] uppercase tracking-wider mb-2">
              {langFlags[lang]} Títulos SEO
            </p>
            <div className="space-y-2">
              {result.titles.map((t, i) => (
                <div key={i} className="flex items-start gap-2 bg-white/[0.04] border border-white/[0.06] rounded-xl px-3.5 py-3">
                  <span className="text-[10px] font-bold text-[#555550] shrink-0 mt-0.5">{i + 1}</span>
                  <p className="flex-1 text-sm leading-relaxed text-[#f2f2ef]">{t}</p>
                  <CopyBtn text={t} />
                </div>
              ))}
            </div>
          </div>

          {/* Descriptions */}
          <div>
            <p className="text-xs font-bold text-[#888880] uppercase tracking-wider mb-2">
              {langFlags[lang]} Descripciones
            </p>
            <div className="space-y-2">
              {result.descriptions.map((d, i) => (
                <div key={i} className="flex items-start gap-2 bg-white/[0.04] border border-white/[0.06] rounded-xl px-3.5 py-3">
                  <span className="text-[10px] font-bold text-[#555550] shrink-0 mt-0.5">{i + 1}</span>
                  <p className="flex-1 text-sm leading-relaxed text-[#cccccc]">{d}</p>
                  <CopyBtn text={d} />
                </div>
              ))}
            </div>
          </div>

          {/* Review reminder */}
          <div className="flex items-start gap-2.5 bg-green-500/[0.08] border border-green-500/20 rounded-xl px-4 py-3">
            <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-green-300">Revisa antes de publicar</p>
              <p className="text-xs text-green-400/70 mt-0.5">
                Comprueba que modelo, color y referencia son correctos. Sustituye <strong>(X)</strong> por la talla real.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
