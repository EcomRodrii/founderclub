import React, { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Upload, Download, Trash2, Images, CheckCircle2,
  Share2, RefreshCcw, Tag, ZapOff,
} from 'lucide-react';
import { generateExifProfile, injectExifProfile, type ExifProfile } from '../lib/randomExif';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MetaJob {
  id: string;
  name: string;
  randomName: string;
  originalUrl: string;
  resultUrl: string | null;
  status: 'pending' | 'processing' | 'done' | 'error';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const IS_MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Convierte cualquier formato (HEIC, PNG, JPEG…) a JPEG vía canvas.
function toJpeg(dataUrl: string, quality = 0.93): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] ?? 'image/jpeg';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function dataUrlToFile(dataUrl: string, name: string): File {
  return new File([dataUrlToBlob(dataUrl)], name, { type: 'image/jpeg' });
}

function dl(dataUrl: string, name: string) {
  const a = document.createElement('a'); a.href = dataUrl; a.download = name; a.click();
}

// Genera un nombre de archivo realista tipo foto de móvil.
function randomPhotoName(): string {
  const r = Math.random();
  if (r < 0.4) {
    // iPhone: IMG_XXXX.JPG
    const n = String(Math.floor(1000 + Math.random() * 8999)).padStart(4, '0');
    return `IMG_${n}.JPG`;
  }
  const d = new Date(Date.now() - Math.floor(Math.random() * 60 * 24 * 60 * 60 * 1000));
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  const h  = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const s  = String(d.getSeconds()).padStart(2, '0');
  if (r < 0.7) {
    // Samsung: YYYYMMDD_HHMMSS.jpg
    return `${y}${mo}${dy}_${h}${mi}${s}.jpg`;
  }
  // Google Pixel: PXL_YYYYMMDD_HHMMSSXXX.MP.jpg
  const ms = String(Math.floor(Math.random() * 999)).padStart(3, '0');
  return `PXL_${y}${mo}${dy}_${h}${mi}${s}${ms}.MP.jpg`;
}

function canShareFiles(): boolean {
  try {
    return (
      typeof navigator.share === 'function' &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [new File([''], 'test.jpg', { type: 'image/jpeg' })] })
    );
  } catch { return false; }
}

// ─── Componente ───────────────────────────────────────────────────────────────

export default function MetadatosEditor() {
  const [jobs, setJobs]         = useState<MetaJob[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback(async (files: File[]) => {
    const imgs = files.filter(f => f.type.startsWith('image/') || /\.heic$/i.test(f.name));
    if (!imgs.length) return;
    setIsProcessing(true);

    // UN perfil EXIF para todo el lote — todas las fotos quedan "del mismo móvil"
    const profile: ExifProfile = generateExifProfile();

    const newJobs: MetaJob[] = imgs.map(f => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: f.name,
      randomName: randomPhotoName(),
      originalUrl: URL.createObjectURL(f),
      resultUrl: null,
      status: 'pending' as const,
    }));
    setJobs(prev => [...newJobs, ...prev]);

    for (const [i, file] of imgs.entries()) {
      const job = newJobs[i];
      setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'processing' } : j));
      try {
        const raw  = await fileToDataUrl(file);
        const jpeg = await toJpeg(raw);
        const result = await injectExifProfile(jpeg, profile);
        setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'done', resultUrl: result } : j));
      } catch {
        setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'error' } : j));
      }
    }

    setIsProcessing(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    processFiles(Array.from(e.dataTransfer.files));
  }, [processFiles]);

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  const doneJobs  = jobs.filter(j => j.status === 'done' && j.resultUrl);
  const doneCount = doneJobs.length;

  const saveAll = async () => {
    if (!doneJobs.length) return;
    setSavingAll(true);
    const items = doneJobs.map(j => ({
      dataUrl: j.resultUrl!,
      name: j.randomName,
    }));

    if (canShareFiles()) {
      try {
        const files = await Promise.all(items.map(i => dataUrlToFile(i.dataUrl, i.name)));
        if (navigator.canShare({ files })) {
          await navigator.share({ files, title: `${files.length} fotos` });
          setSavingAll(false); return;
        }
      } catch { /* fallback */ }
      // Share una a una
      for (const item of items) {
        try {
          const file = await dataUrlToFile(item.dataUrl, item.name);
          await navigator.share({ files: [file], title: item.name });
        } catch { /* usuario canceló */ }
      }
    } else {
      items.forEach((item, idx) => setTimeout(() => dl(item.dataUrl, item.name), idx * 120));
    }
    setSavingAll(false);
  };

  const saveSingle = async (job: MetaJob) => {
    const name = job.randomName;
    if (canShareFiles()) {
      try {
        const file = await dataUrlToFile(job.resultUrl!, name);
        await navigator.share({ files: [file], title: name });
        return;
      } catch { /* fallback */ }
    }
    dl(job.resultUrl!, name);
  };

  const removeJob = (id: string) => setJobs(prev => prev.filter(j => j.id !== id));
  const clearAll  = () => { if (!isProcessing) setJobs([]); };

  const saveLabel    = IS_MOBILE ? 'Guardar' : 'Descargar';
  const saveAllLabel = IS_MOBILE ? 'Guardar en galería' : 'Descargar todas';

  return (
    <div className="space-y-6 pb-24 lg:pb-6">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div>
        <p className="font-display text-[0.75rem] tracking-[0.3em] text-[#d4ff00]">PRIVACIDAD</p>
        <h1 className="font-display text-[2.4rem] leading-none tracking-[0.02em] text-[#f2f2ef] mt-1">Metadatos</h1>
        <p className="text-[0.82rem] text-[#888880] mt-2 leading-relaxed">
          Cambia los metadatos EXIF de tus fotos para que Vinted no detecte que son las mismas imágenes publicadas desde otra cuenta.
          Todas las fotos del lote quedan con el mismo dispositivo y fecha — como si las hubiera hecho un comprador con su móvil.
        </p>
      </div>

      {/* ── Drop zone ───────────────────────────────────────────────────────── */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => !isProcessing && inputRef.current?.click()}
        className={`relative border-2 border-dashed rounded-3xl p-10 text-center transition-all ${
          isProcessing ? 'cursor-not-allowed opacity-60' :
          dragging      ? 'border-[#d4ff00] bg-[#d4ff00]/[0.05] scale-[1.01] cursor-copy' :
          'border-white/10 hover:border-white/20 hover:bg-white/[0.02] cursor-pointer'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*,.heic,.HEIC"
          multiple
          className="hidden"
          onChange={handleInput}
          disabled={isProcessing}
        />
        <div className="flex flex-col items-center gap-3">
          <div className={`w-16 h-16 rounded-2xl flex items-center justify-center border transition-all ${
            dragging ? 'bg-[#d4ff00]/10 border-[#d4ff00]' : 'bg-white/5 border-white/10'
          }`}>
            {isProcessing
              ? <RefreshCcw className="w-7 h-7 text-[#d4ff00] animate-spin" />
              : <Tag className={`w-7 h-7 ${dragging ? 'text-[#d4ff00]' : 'text-white/40'}`} />
            }
          </div>
          <div>
            <p className="text-[#f2f2ef] font-semibold">
              {isProcessing ? 'Procesando metadatos…' : 'Adjunta las fotos aquí'}
            </p>
            <p className="text-white/40 text-sm mt-1">
              {isProcessing ? 'Un momento…' : 'Puedes seleccionar varias a la vez'}
            </p>
          </div>
        </div>
      </div>

      {/* ── Barra de acciones ───────────────────────────────────────────────── */}
      {jobs.length > 0 && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm text-white/50">
            <span className="text-white font-bold">{doneCount}</span>/{jobs.length} listas
          </p>
          <div className="flex gap-2">
            {doneCount > 0 && (
              <button
                onClick={saveAll}
                disabled={savingAll}
                className="flex items-center gap-2 bg-[#d4ff00] hover:bg-[#c8f000] disabled:opacity-60 text-black font-bold px-4 py-2 rounded-xl text-sm transition"
              >
                {savingAll
                  ? <><RefreshCcw className="w-4 h-4 animate-spin" />Guardando…</>
                  : IS_MOBILE
                    ? <><Share2 className="w-4 h-4" />{saveAllLabel} ({doneCount})</>
                    : <><Images className="w-4 h-4" />{saveAllLabel} ({doneCount})</>
                }
              </button>
            )}
            <button
              onClick={clearAll}
              disabled={isProcessing}
              className="flex items-center gap-2 bg-white/5 hover:bg-red-500/10 text-white/40 hover:text-red-400 border border-white/10 px-4 py-2 rounded-xl text-sm transition disabled:opacity-40"
            >
              <Trash2 className="w-4 h-4" />Limpiar
            </button>
          </div>
        </div>
      )}

      {/* ── Grid ────────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <AnimatePresence>
          {jobs.map(job => (
            <motion.div key={job.id}
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.88 }}
              className="bg-[#141414] border border-white/5 rounded-2xl overflow-hidden"
            >
              {/* Thumbnail */}
              <div className="relative aspect-square bg-black/40 flex items-center justify-center overflow-hidden">
                {job.resultUrl ? (
                  <img src={job.resultUrl} alt={job.name} className="w-full h-full object-cover" />
                ) : job.status === 'processing' ? (
                  <>
                    <img src={job.originalUrl} alt="" className="absolute inset-0 w-full h-full object-cover"
                      style={{ filter: 'blur(8px) brightness(0.35)' }} />
                    <div className="relative z-10 flex flex-col items-center gap-1.5">
                      <RefreshCcw className="w-6 h-6 text-[#d4ff00] animate-spin" />
                      <span className="text-[10px] text-white/50">Procesando…</span>
                    </div>
                  </>
                ) : job.status === 'pending' ? (
                  <>
                    <img src={job.originalUrl} alt="" className="absolute inset-0 w-full h-full object-cover"
                      style={{ filter: 'blur(4px) brightness(0.25)' }} />
                    <span className="relative z-10 text-[10px] text-white/30">En cola…</span>
                  </>
                ) : job.status === 'error' ? (
                  <div className="flex flex-col items-center gap-1.5 text-red-400/60">
                    <ZapOff className="w-6 h-6" />
                    <span className="text-[10px]">Error</span>
                  </div>
                ) : null}

                {job.status === 'done' && (
                  <div className="absolute top-2 right-2 bg-[#d4ff00] rounded-full p-1">
                    <CheckCircle2 className="w-3 h-3 text-black" />
                  </div>
                )}
                {/* Botón borrar */}
                <button
                  onClick={e => { e.stopPropagation(); removeJob(job.id); }}
                  className="absolute top-2 left-2 w-6 h-6 rounded-full bg-black/50 flex items-center justify-center text-white/40 hover:text-white hover:bg-black/80 transition"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                    <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>

              {/* Footer */}
              <div className="px-3 py-2.5 space-y-2">
                <p className="text-[11px] text-white/50 truncate">{job.name}</p>
                {job.status === 'done' && job.resultUrl && (
                  <button
                    onClick={() => saveSingle(job)}
                    className="w-full flex items-center justify-center gap-1.5 bg-[#d4ff00] hover:bg-[#c8f000] text-black font-bold py-1.5 rounded-lg text-xs transition"
                  >
                    {IS_MOBILE ? <Share2 className="w-3 h-3" /> : <Download className="w-3 h-3" />}
                    {saveLabel}
                  </button>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
