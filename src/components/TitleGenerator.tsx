import React, { useState } from 'react';
import { Copy, Check, RefreshCcw, CheckCircle2 } from 'lucide-react';

type Lang = 'es' | 'fr' | 'en';
type Gender = 'mujer' | 'hombre' | 'unisex';

interface Result {
  titles: string[];
  descriptions: string[];
}

const BRANDS = [
  'Adidas', 'Nike', 'New Balance', 'Onitsuka Tiger', 'Asics',
  'Puma', 'Vans', 'Converse', 'Salomon', 'Saucony', 'Reebok', 'Otra',
];

const GENDER_LABELS: Record<Gender, string> = {
  mujer: '👩 Mujer',
  hombre: '👨 Hombre',
  unisex: '⚡ Unisex',
};

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
  const [brand, setBrand] = useState('Adidas');
  const [brandCustom, setBrandCustom] = useState('');
  const [model, setModel] = useState('');
  const [color, setColor] = useState('');
  const [code, setCode] = useState('');
  const [gender, setGender] = useState<Gender>('mujer');
  const [lang, setLang] = useState<Lang>('es');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolvedBrand = brand === 'Otra' ? brandCustom.trim() : brand;
  const canGenerate = resolvedBrand.length > 0 && model.trim().length > 0 && color.trim().length > 0;

  const generate = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch('/api/titles/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          brand: resolvedBrand,
          model: model.trim(),
          color: color.trim(),
          gender,
          code: code.trim().toUpperCase() || undefined,
          lang,
        }),
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

  const langFlags: Record<Lang, string> = { es: '🇪🇸', fr: '🇫🇷', en: '🇬🇧' };
  const langLabels: Record<Lang, string> = { es: 'Español', fr: 'Français', en: 'English' };

  return (
    <div className="max-w-xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-lg font-bold text-[#f2f2ef]">Títulos y descripciones IA</h1>
        <p className="text-[0.78rem] text-[#888880] mt-0.5">
          Rellena los datos de la zapatilla → la IA escribe los textos listos para Vinted
        </p>
      </div>

      {/* Form */}
      <div className="space-y-4">
        {/* Marca */}
        <div>
          <label className="block text-xs text-[#888880] mb-1.5">Marca</label>
          <div className="flex flex-wrap gap-1.5">
            {BRANDS.map(b => (
              <button
                key={b}
                onClick={() => setBrand(b)}
                className={`px-3 py-1.5 rounded-xl text-sm border transition ${
                  brand === b
                    ? 'bg-[#d4ff00]/10 border-[#d4ff00]/40 text-[#d4ff00]'
                    : 'bg-white/[0.04] border-white/[0.08] text-[#888880] hover:text-[#f2f2ef]'
                }`}
              >
                {b}
              </button>
            ))}
          </div>
          {brand === 'Otra' && (
            <input
              type="text"
              value={brandCustom}
              onChange={e => setBrandCustom(e.target.value)}
              placeholder="Nombre de la marca"
              className="mt-2 w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-[#f2f2ef] text-sm placeholder-[#444440] focus:outline-none focus:border-[#d4ff00]/40 transition"
            />
          )}
        </div>

        {/* Modelo */}
        <div>
          <label className="block text-xs text-[#888880] mb-1.5">Modelo</label>
          <input
            type="text"
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder="Ej: Samba OG, 574, Gel-Lyte III…"
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-[#f2f2ef] text-sm placeholder-[#444440] focus:outline-none focus:border-[#d4ff00]/40 transition"
          />
        </div>

        {/* Color + Código en fila */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-[#888880] mb-1.5">Color</label>
            <input
              type="text"
              value={color}
              onChange={e => setColor(e.target.value)}
              placeholder="Ej: Blanco/Negro"
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-[#f2f2ef] text-sm placeholder-[#444440] focus:outline-none focus:border-[#d4ff00]/40 transition"
            />
          </div>
          <div>
            <label className="block text-xs text-[#888880] mb-1.5">Código <span className="text-[#555550]">(opcional)</span></label>
            <input
              type="text"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              placeholder="Ej: JQ5874"
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-[#f2f2ef] text-sm font-mono placeholder-[#444440] focus:outline-none focus:border-[#d4ff00]/40 transition"
            />
          </div>
        </div>

        {/* Género */}
        <div>
          <label className="block text-xs text-[#888880] mb-1.5">Para quién</label>
          <div className="flex gap-2">
            {(['mujer', 'hombre', 'unisex'] as Gender[]).map(g => (
              <button
                key={g}
                onClick={() => setGender(g)}
                className={`flex-1 py-2 rounded-xl text-sm font-semibold border transition ${
                  gender === g
                    ? 'bg-[#d4ff00]/10 border-[#d4ff00]/40 text-[#d4ff00]'
                    : 'bg-white/[0.04] border-white/[0.08] text-[#888880] hover:text-[#f2f2ef]'
                }`}
              >
                {GENDER_LABELS[g]}
              </button>
            ))}
          </div>
        </div>

        {/* Idioma */}
        <div>
          <label className="block text-xs text-[#888880] mb-1.5">Idioma</label>
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
                Comprueba que todo cuadra y es coherente. Sustituye <strong>(X)</strong> por la talla real.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
