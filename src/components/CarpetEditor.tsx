import React, { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Upload, Download, RefreshCcw, Trash2, Shuffle,
  ImageIcon, ZapOff, Images, CheckCircle2, X,
  Sparkles, Palette, Crown, MessageCircle,
} from 'lucide-react';
import { generateExifProfile, injectExifProfile, type ExifProfile } from '../lib/randomExif';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CarpetJob {
  id: string;
  originalName: string;
  originalUrl: string;
  resultUrl: string | null;
  originalSize: number;
  status: 'pending' | 'processing' | 'done' | 'error';
  errorMsg?: string;
  startedAt?: number;
}

// ─── Preset colors ────────────────────────────────────────────────────────────

const CARPET_PRESETS = [
  { label: 'Beige claro',  value: 'beige claro suave, textura de pelo corto uniforme',           color: '#e8d9c0' },
  { label: 'Blanco',       value: 'blanco puro, pelo corto y denso, estudio fotográfico',         color: '#f5f5f5' },
  { label: 'Gris claro',   value: 'gris claro neutro, textura de alfombra lisa y uniforme',       color: '#d0d0d0' },
  { label: 'Gris oscuro',  value: 'gris oscuro antracita, alfombra de pelo corto',                color: '#5a5a5a' },
  { label: 'Crema',        value: 'crema cálido, alfombra de pelo largo suave',                   color: '#f0e6d3' },
  { label: 'Negro',        value: 'negro mate profundo, alfombra de pelo fino y uniforme',        color: '#1a1a1a' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const IS_MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

function formatSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function dl(dataUrl: string, name: string): Promise<void> {
  const blob    = await fetch(dataUrl).then(r => r.blob());
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 5_000);
}

// Gemini devuelve PNG; piexifjs solo funciona con JPEG → convertir antes de inyectar EXIF.
function pngToJpeg(dataUrl: string, quality = 0.93): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// Convierte el PNG de Gemini a JPEG e inyecta el perfil EXIF del lote.
async function applyBatchExif(pngDataUrl: string, profile: ExifProfile): Promise<string> {
  const jpeg = await pngToJpeg(pngDataUrl);
  return injectExifProfile(jpeg, profile);
}

async function saveAll(
  items: { dataUrl: string; filename: string }[],
  onProgress?: (n: number) => void
): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    await dl(items[i].dataUrl, items[i].filename);
    onProgress?.(i + 1);
    if (i < items.length - 1) await new Promise(r => setTimeout(r, 150));
  }
}

// ─── Elapsed timer (ticker propio para no rerender todo el árbol) ─────────────

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [secs, setSecs] = React.useState(() => Math.floor((Date.now() - startedAt) / 1000));
  React.useEffect(() => {
    const t = setInterval(() => setSecs(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return <span>{secs}s</span>;
}

// ─── Locked screen ────────────────────────────────────────────────────────────

function LockedPro() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[65vh] gap-6 text-center px-4">
      <div className="w-16 h-16 rounded-2xl bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center">
        <Crown className="w-7 h-7 text-yellow-400" />
      </div>
      <div>
        <h2 className="text-xl font-bold text-[#f2f2ef]">Función exclusiva Pro</h2>
        <p className="text-[#888880] mt-2 max-w-xs leading-relaxed">
          La herramienta de <span className="text-yellow-400 font-semibold">Alfombras</span> solo está disponible para miembros <span className="text-yellow-400 font-semibold">Pro</span>.
        </p>
        <p className="text-[#888880] mt-1 text-sm">8,99€/mes · escríbeme para activarla</p>
      </div>
      <a
        href="https://wa.me/message/XXXXXXXXX"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 bg-[#25D366] hover:bg-[#1eb857] text-white font-bold px-6 py-3 rounded-xl transition shadow-[0_12px_32px_-8px_rgba(37,211,102,0.35)]"
      >
        <MessageCircle className="w-4 h-4" />
        Escribir al WhatsApp
      </a>
    </div>
  );
}

// ─── Componente ───────────────────────────────────────────────────────────────

export default function CarpetEditor({ token, isPro = false, isAdmin = false }: { token: string; isPro?: boolean; isAdmin?: boolean }) {
  const [jobs, setJobs]               = useState<CarpetJob[]>([]);
  const [carpetColor, setCarpetColor] = useState(CARPET_PRESETS[0].value);
  const [customColor, setCustomColor] = useState('');
  const [useCustom, setUseCustom]     = useState(false);
  const [refImage, setRefImage]       = useState<string | null>(null);
  const [refName, setRefName]         = useState<string>('');
  const [dragging, setDragging]       = useState(false);
  const [savingAll, setSavingAll]     = useState(false);
  const [savedCount, setSavedCount]   = useState(0);
  const [isRunning, setIsRunning]     = useState(false);

  const productInputRef = useRef<HTMLInputElement>(null);
  const refInputRef     = useRef<HTMLInputElement>(null);

  const effectiveColor = useCustom && customColor.trim()
    ? customColor.trim()
    : carpetColor;

  // ── Subir referencia de alfombra ────────────────────────────────────────────
  const handleRefInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const b64 = await fileToBase64(file);
    setRefImage(b64);
    setRefName(file.name);
  };

  // ── Procesar imágenes de producto ────────────────────────────────────────────
  const processFiles = useCallback(async (files: File[]) => {
    const imgs = files.filter(f => f.type.startsWith('image/') || f.name.toLowerCase().endsWith('.heic'));
    if (!imgs.length) return;
    setIsRunning(true);

    // Un único perfil EXIF para todo el lote — todas las fotos quedan "del mismo móvil"
    const batchProfile: ExifProfile = generateExifProfile();

    const newJobs: CarpetJob[] = imgs.map(f => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      originalName: f.name,
      originalUrl: URL.createObjectURL(f),
      resultUrl: null,
      originalSize: f.size,
      status: 'pending' as const,
    }));
    setJobs(prev => [...newJobs, ...prev]);

    for (const [i, file] of imgs.entries()) {
      const job = newJobs[i];
      setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'processing', startedAt: Date.now() } : j));

      try {
        const imageBase64 = await fileToBase64(file);
        const body: any = { imageBase64, carpetColor: effectiveColor };
        if (refImage) body.referenceBase64 = refImage;

        const res = await fetch('/api/carpet/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });

        const data = await res.json();

        if (!res.ok) {
          setJobs(prev => prev.map(j =>
            j.id === job.id ? { ...j, status: 'error', errorMsg: data?.error || `Error ${res.status}` } : j
          ));
          continue;
        }

        // Convertir PNG→JPEG e inyectar el mismo perfil EXIF del lote
        const resultUrl = await applyBatchExif(data.image, batchProfile);

        setJobs(prev => prev.map(j =>
          j.id === job.id ? { ...j, status: 'done', resultUrl } : j
        ));
      } catch (err: any) {
        setJobs(prev => prev.map(j =>
          j.id === job.id ? { ...j, status: 'error', errorMsg: err.message || 'Error desconocido' } : j
        ));
      }
    }

    setIsRunning(false);
  }, [token, effectiveColor, refImage]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    processFiles(Array.from(e.dataTransfer.files));
  }, [processFiles]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  const reprocess = async (id: string) => {
    const job = jobs.find(j => j.id === id); if (!job) return;
    setJobs(prev => prev.map(j => j.id === id ? { ...j, status: 'processing', resultUrl: null, startedAt: Date.now() } : j));
    try {
      const res = await fetch(job.originalUrl);
      const blob = await res.blob();
      const file = new File([blob], job.originalName, { type: blob.type || 'image/jpeg' });
      const imageBase64 = await fileToBase64(file);
      const body: any = { imageBase64, carpetColor: effectiveColor };
      if (refImage) body.referenceBase64 = refImage;
      const r = await fetch('/api/carpet/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `Error ${r.status}`);
      const resultUrl = await applyBatchExif(data.image, generateExifProfile());
      setJobs(prev => prev.map(j => j.id === id ? { ...j, status: 'done', resultUrl } : j));
    } catch (err: any) {
      setJobs(prev => prev.map(j => j.id === id ? { ...j, status: 'error', errorMsg: err.message } : j));
    }
  };

  const remove   = (id: string) => setJobs(prev => prev.filter(j => j.id !== id));
  const clearAll = () => setJobs([]);

  const doneJobs  = jobs.filter(j => j.status === 'done' && j.resultUrl);
  const doneCount = doneJobs.length;

  const handleSaveAll = async () => {
    if (!doneJobs.length) return;
    setSavingAll(true); setSavedCount(0);
    const items = doneJobs.map((j, idx) => ({
      dataUrl: j.resultUrl!,
      filename: `${j.originalName.replace(/\.[^.]+$/, '')}_alfombra_${idx + 1}.jpg`,
    }));
    try { await saveAll(items, n => setSavedCount(n)); }
    finally { setSavingAll(false); }
  };

  const saveLabel    = IS_MOBILE ? 'Guardar' : 'Descargar';
  const saveAllLabel = IS_MOBILE ? 'Guardar en galería' : 'Descargar todas';

  // Gate: usuarios sin Pro ni admin ven pantalla bloqueada
  if (!isAdmin && !isPro) return <LockedPro />;

  return (
    <div className="space-y-6 pb-24 lg:pb-6">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div>
        <p className="font-display text-[0.75rem] tracking-[0.3em] text-[#d4ff00]">EDICIÓN IA</p>
        <h1 className="font-display text-[2.4rem] leading-none tracking-[0.02em] text-[#f2f2ef] mt-1">Alfombras</h1>
        <p className="text-[0.82rem] text-[#888880] mt-2">
          Cambia el fondo de alfombra de tus fotos de producto. El artículo queda intacto.
        </p>
      </div>

      {/* ── Selección de color de alfombra ──────────────────────────────────── */}
      <div className="bg-[#161616] border border-white/[0.06] rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Palette className="w-4 h-4 text-[#d4ff00]" />
          <p className="text-[0.85rem] font-semibold text-[#f2f2ef]">Color de alfombra destino</p>
        </div>

        {/* Presets */}
        <div className="grid grid-cols-3 gap-2">
          {CARPET_PRESETS.map(p => {
            const active = !useCustom && carpetColor === p.value;
            return (
              <button
                key={p.value}
                onClick={() => { setCarpetColor(p.value); setUseCustom(false); }}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-left transition-all ${
                  active
                    ? 'border-[#d4ff00]/60 bg-[#d4ff00]/10'
                    : 'border-white/[0.08] bg-white/[0.03] hover:border-white/20'
                }`}
              >
                <span
                  className="w-5 h-5 rounded-full border border-white/20 shrink-0"
                  style={{ backgroundColor: p.color }}
                />
                <span className={`text-[0.75rem] font-medium leading-tight ${active ? 'text-[#d4ff00]' : 'text-[#888880]'}`}>
                  {p.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* Custom text */}
        <div>
          <button
            onClick={() => setUseCustom(v => !v)}
            className={`text-[0.75rem] font-medium transition-colors ${useCustom ? 'text-[#d4ff00]' : 'text-[#888880] hover:text-[#f2f2ef]'}`}
          >
            {useCustom ? '✓ ' : '+ '}Personalizado (escribe el color o estilo)
          </button>
          {useCustom && (
            <input
              type="text"
              placeholder="Ej: verde musgo suave, pelo largo, studio blanco con degradado..."
              value={customColor}
              onChange={e => setCustomColor(e.target.value)}
              autoFocus
              className="mt-2 w-full bg-[#111] border border-white/[0.12] rounded-xl px-4 py-2.5 text-sm text-[#f2f2ef] placeholder-[#555550] focus:outline-none focus:border-[#d4ff00]/50"
            />
          )}
        </div>
      </div>

      {/* ── Referencia de alfombra (opcional) ──────────────────────────────── */}
      <div className="bg-[#161616] border border-white/[0.06] rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-[#888880]" />
            <p className="text-[0.85rem] font-semibold text-[#f2f2ef]">Foto de referencia</p>
            <span className="text-[0.7rem] text-[#555550] bg-white/[0.05] px-2 py-0.5 rounded-full">Opcional</span>
          </div>
          {refImage && (
            <button
              onClick={() => { setRefImage(null); setRefName(''); }}
              className="text-[#555550] hover:text-[#ff8080] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {refImage ? (
          <div className="flex items-center gap-3">
            <img src={refImage} alt="referencia" className="w-16 h-16 object-cover rounded-xl border border-white/10" />
            <div>
              <p className="text-[0.78rem] text-[#f2f2ef] font-medium truncate max-w-[200px]">{refName}</p>
              <p className="text-[0.7rem] text-[#888880]">La IA usará esta alfombra como referencia de estilo</p>
            </div>
          </div>
        ) : (
          <button
            onClick={() => refInputRef.current?.click()}
            className="w-full flex items-center gap-3 px-4 py-3 border border-dashed border-white/[0.12] rounded-xl text-[0.82rem] text-[#555550] hover:text-[#f2f2ef] hover:border-white/25 transition-all"
          >
            <Upload className="w-4 h-4 shrink-0" />
            Adjunta una foto de la alfombra que quieres usar como modelo
          </button>
        )}
        <input ref={refInputRef} type="file" accept="image/*,.heic,.HEIC" className="hidden" onChange={handleRefInput} />
      </div>

      {/* ── Drop zone ───────────────────────────────────────────────────────── */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => !isRunning && productInputRef.current?.click()}
        className={`relative border-2 border-dashed rounded-3xl p-10 text-center transition-all ${
          isRunning ? 'cursor-not-allowed opacity-60' :
          dragging   ? 'border-[#d4ff00] bg-[#d4ff00]/[0.05] scale-[1.01] cursor-copy' :
          'border-white/10 hover:border-white/20 hover:bg-white/[0.02] cursor-pointer'
        }`}
      >
        <input
          ref={productInputRef}
          type="file"
          accept="image/*,.heic,.HEIC"
          multiple
          className="hidden"
          onChange={handleFileInput}
          disabled={isRunning}
        />
        <div className="flex flex-col items-center gap-3">
          <div className={`w-16 h-16 rounded-2xl flex items-center justify-center border transition-all ${
            dragging ? 'bg-[#d4ff00]/10 border-[#d4ff00]' : 'bg-white/5 border-white/10'
          }`}>
            {isRunning
              ? <RefreshCcw className="w-7 h-7 text-[#d4ff00] animate-spin" />
              : <Upload className={`w-7 h-7 ${dragging ? 'text-[#d4ff00]' : 'text-white/40'}`} />
            }
          </div>
          <div>
            <p className="text-[#f2f2ef] font-semibold">
              {isRunning ? 'Procesando fotos…' : 'Arrastra las fotos del producto aquí'}
            </p>
            <p className="text-white/40 text-sm mt-1">
              {isRunning
                ? 'Cada imagen tarda ~15–30 segundos'
                : 'Puedes adjuntar varias fotos a la vez'}
            </p>
            {!isRunning && (
              <p className="text-white/25 text-xs mt-0.5">
                Alfombra: {useCustom && customColor.trim() ? customColor.trim() : CARPET_PRESETS.find(p => p.value === carpetColor)?.label || carpetColor}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Barra de acciones ───────────────────────────────────────────────── */}
      {jobs.length > 0 && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm text-white/50">
            <span className="text-white font-bold">{doneCount}</span>/{jobs.length} listas
            {savingAll && savedCount > 0 && (
              <span className="ml-2 text-[#d4ff00] font-bold">· Guardadas {savedCount}</span>
            )}
          </p>
          <div className="flex gap-2">
            {doneCount > 0 && (
              <button
                onClick={handleSaveAll}
                disabled={savingAll}
                className="flex items-center gap-2 bg-[#d4ff00] hover:bg-[#c8f000] disabled:opacity-60 text-black font-bold px-4 py-2 rounded-xl text-sm transition"
              >
                {savingAll
                  ? <><RefreshCcw className="w-4 h-4 animate-spin" />{savedCount}/{doneCount}</>
                  : <><Images className="w-4 h-4" />{saveAllLabel} ({doneCount})</>
                }
              </button>
            )}
            <button onClick={clearAll} className="flex items-center gap-2 bg-white/5 hover:bg-red-500/10 text-white/40 hover:text-red-400 border border-white/10 px-4 py-2 rounded-xl text-sm transition">
              <Trash2 className="w-4 h-4" />Limpiar
            </button>
          </div>
        </div>
      )}

      {/* ── Grid de resultados ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <AnimatePresence>
          {jobs.map(job => (
            <motion.div key={job.id}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-[#141414] border border-white/5 rounded-2xl overflow-hidden"
            >
              {/* Imagen */}
              <div className="relative aspect-square bg-black/40 flex items-center justify-center overflow-hidden">
                {job.resultUrl ? (
                  <img src={job.resultUrl} alt={job.originalName} className="w-full h-full object-cover" />
                ) : job.status === 'processing' ? (
                  <>
                    {/* Original difuminada de fondo */}
                    <img
                      src={job.originalUrl}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover scale-105"
                      style={{ filter: 'blur(12px) brightness(0.35) saturate(0.6)' }}
                    />
                    {/* Shimmer sweep */}
                    <div className="absolute inset-0 overflow-hidden">
                      <div
                        className="absolute inset-y-0 w-1/3"
                        style={{
                          background: 'linear-gradient(90deg, transparent, rgba(212,255,0,0.07), transparent)',
                          animation: 'shimmer-sweep 2s ease-in-out infinite',
                        }}
                      />
                    </div>
                    {/* Contenido central */}
                    <div className="relative z-10 flex flex-col items-center gap-2 px-4 w-full">
                      <Sparkles className="w-7 h-7 text-[#d4ff00]" style={{ animation: 'pulse 1.5s ease-in-out infinite' }} />
                      <p className="text-[0.78rem] font-semibold text-white/90">Editando alfombra…</p>
                      {/* Barra de progreso animada */}
                      <div className="w-full bg-white/10 rounded-full h-1 overflow-hidden mt-1">
                        <motion.div
                          className="h-1 rounded-full bg-[#d4ff00]"
                          initial={{ width: '0%' }}
                          animate={{ width: '88%' }}
                          transition={{ duration: 50, ease: 'linear' }}
                        />
                      </div>
                      <p className="text-[10px] text-white/30 tabular-nums">
                        {job.startedAt ? <ElapsedTimer startedAt={job.startedAt} /> : '0s'}
                      </p>
                    </div>
                  </>
                ) : job.status === 'pending' ? (
                  <>
                    <img
                      src={job.originalUrl}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover"
                      style={{ filter: 'blur(6px) brightness(0.25)' }}
                    />
                    <div className="relative z-10 flex flex-col items-center gap-2">
                      <RefreshCcw className="w-6 h-6 text-white/30 animate-spin" />
                      <span className="text-[11px] text-white/30">En cola…</span>
                    </div>
                  </>
                ) : job.status === 'error' ? (
                  <div className="flex flex-col items-center gap-2 text-red-400/60 px-4 text-center">
                    <ZapOff className="w-8 h-8" />
                    <span className="text-xs leading-snug">{job.errorMsg || 'Error'}</span>
                  </div>
                ) : (
                  <ImageIcon className="w-12 h-12 text-white/10" />
                )}
                {job.status === 'done' && (
                  <div className="absolute top-2 right-2 bg-[#d4ff00] rounded-full p-1">
                    <CheckCircle2 className="w-3.5 h-3.5 text-black" />
                  </div>
                )}
                {/* Original preview — solo cuando está listo */}
                {job.status === 'done' && (
                  <div className="absolute bottom-2 left-2">
                    <img src={job.originalUrl} alt="original" className="w-10 h-10 object-cover rounded-lg border border-white/20 opacity-70" />
                  </div>
                )}
              </div>

              {/* Info + acciones */}
              <div className="p-4 space-y-3">
                <p className="text-xs text-white/70 truncate font-medium">{job.originalName}</p>
                {job.status === 'done' && (
                  <div className="flex justify-between text-[10px] text-[#d4ff00]">
                    <span>Editada</span>
                    <span className="font-mono">{formatSize(job.originalSize)}</span>
                  </div>
                )}
                <div className="flex gap-2">
                  {job.status === 'done' && job.resultUrl && (
                    <button
                      onClick={() => dl(job.resultUrl!, job.originalName.replace(/\.[^.]+$/, '_alfombra.jpg'))}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-[#d4ff00] hover:bg-[#c8f000] text-black font-bold py-2 rounded-xl text-xs transition"
                    >
                      <Download className="w-3.5 h-3.5" />{saveLabel}
                    </button>
                  )}
                  {(job.status === 'done' || job.status === 'error') && (
                    <button
                      onClick={() => reprocess(job.id)}
                      title="Regenerar"
                      className="p-2 bg-white/5 hover:bg-white/10 text-white/40 hover:text-[#d4ff00] rounded-xl border border-white/5 transition"
                    >
                      <Shuffle className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => remove(job.id)}
                    className="p-2 bg-white/5 hover:bg-red-500/10 text-white/20 hover:text-red-400 rounded-xl border border-white/5 transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {jobs.length === 0 && (
        <p className="text-center py-6 text-white/20 text-sm">
          Sube las fotos del producto para cambiar la alfombra
        </p>
      )}
    </div>
  );
}
