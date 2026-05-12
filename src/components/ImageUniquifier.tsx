import React, { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Upload, Download, RefreshCcw, Trash2,
  Shuffle, Package, ZapOff, Eye, EyeOff, Camera
} from 'lucide-react';

// ─── Tipos ───────────────────────────────────────────────────────────────────

type Intensity = 'suave' | 'normal' | 'fuerte' | 'extremo';

interface Techniques {
  crop:       string;
  rotation:   string;
  skew:       string;
  noise:      string;
  brightness: string;
  contrast:   string;
  quality:    string;
}

interface ProcessedImage {
  id:            string;
  file:          File;
  originalUrl:   string;
  processedUrl:  string | null;
  originalSize:  number;
  processedSize: number;
  status:        'pending' | 'processing' | 'done' | 'error';
  techniques:    Techniques | null;
  showOriginal:  boolean;
}

// ─── Configuración por intensidad ────────────────────────────────────────────

const INTENSITY_CONFIG = {
  suave:   {
    crop: [1, 3],   rotation: 0.3, skew: 1.0, noise: 1,
    brightness: [-2,  2],  contrast: [0.99, 1.01], quality: [0.93, 0.96],
    label: 'Suave',   color: 'text-blue-400',
    bg:    'bg-blue-500/10 border-blue-500/20',
    desc:  'Cambios mínimos. Foto visualmente idéntica.',
  },
  normal:  {
    crop: [2, 6],   rotation: 0.7, skew: 2.0, noise: 2,
    brightness: [-4,  4],  contrast: [0.97, 1.03], quality: [0.88, 0.94],
    label: 'Normal',  color: 'text-emerald-400',
    bg:    'bg-emerald-500/10 border-emerald-500/20',
    desc:  'Equilibrio perfecto. Recomendado para uso diario.',
  },
  fuerte:  {
    crop: [4, 10],  rotation: 1.2, skew: 3.5, noise: 3,
    brightness: [-6,  6],  contrast: [0.95, 1.05], quality: [0.84, 0.91],
    label: 'Fuerte',  color: 'text-amber-400',
    bg:    'bg-amber-500/10 border-amber-500/20',
    desc:  'Cambios agresivos. Rompe hasta detección por IA.',
  },
  extremo: {
    crop: [6, 14],  rotation: 1.8, skew: 5.0, noise: 5,
    brightness: [-8,  8],  contrast: [0.93, 1.07], quality: [0.80, 0.88],
    label: 'Extremo', color: 'text-red-400',
    bg:    'bg-red-500/10 border-red-500/20',
    desc:  'Máxima evasión. Undetectable por cualquier sistema.',
  },
};

// ─── Motor de uniquificación ──────────────────────────────────────────────────

function rnd(min: number, max: number) { return Math.random() * (max - min) + min; }
function rndInt(min: number, max: number) { return Math.floor(rnd(min, max + 1)); }
function clamp(v: number) { return Math.min(255, Math.max(0, Math.round(v))); }

async function uniquifyImage(
  file: File,
  intensity: Intensity,
): Promise<{ dataUrl: string; size: number; techniques: Techniques }> {
  return new Promise((resolve, reject) => {
    const cfg = INTENSITY_CONFIG[intensity];
    const img = new Image();

    img.onload = () => {
      const W = img.width;
      const H = img.height;

      // ── 1. Recorte (píxeles a eliminar por cada borde) ──────────────────
      const cropT = rndInt(cfg.crop[0], cfg.crop[1]);
      const cropB = rndInt(cfg.crop[0], cfg.crop[1]);
      const cropL = rndInt(cfg.crop[0], cfg.crop[1]);
      const cropR = rndInt(cfg.crop[0], cfg.crop[1]);

      // ── 2. Micro-rotación ────────────────────────────────────────────────
      const rotDeg = rnd(-cfg.rotation, cfg.rotation);
      const rotRad = rotDeg * Math.PI / 180;
      // Escala para que la rotación no deje esquinas negras
      const rotScale = 1 / (Math.cos(Math.abs(rotRad)) - Math.sin(Math.abs(rotRad)) * (H / W)) + 0.015;

      // ── 3. Ángulo de cámara (skew afín) ─────────────────────────────────
      // Simula que la foto fue tomada desde un ángulo ligeramente diferente.
      // sx = inclinación horizontal (izq/der), sy = inclinación vertical (arr/abajo)
      const skewXDeg = rnd(-cfg.skew, cfg.skew);
      const skewYDeg = rnd(-cfg.skew / 2, cfg.skew / 2);
      const sx = Math.tan(skewXDeg * Math.PI / 180);
      const sy = Math.tan(skewYDeg * Math.PI / 180);

      // Padding extra para que el skew no deje bordes negros
      const padX = Math.ceil(Math.abs(sx) * H * 0.6) + 20;
      const padY = Math.ceil(Math.abs(sy) * W * 0.6) + 20;

      // ── 4. Canvas temporal (más grande para acomodar transformaciones) ───
      const tmpW = W + padX * 2;
      const tmpH = H + padY * 2;
      const tmp  = document.createElement('canvas');
      tmp.width  = tmpW;
      tmp.height = tmpH;
      const tc   = tmp.getContext('2d')!;

      tc.save();
      tc.translate(tmpW / 2, tmpH / 2);
      tc.rotate(rotRad);
      tc.scale(rotScale, rotScale);
      // Skew afín: transform(scaleX, skewY, skewX, scaleY, tx, ty)
      tc.transform(1, sy, sx, 1, 0, 0);
      tc.drawImage(img, -W / 2, -H / 2, W, H);
      tc.restore();

      // ── 5. Canvas final: extraer centro con recorte ─────────────────────
      const finalW = W - cropL - cropR;
      const finalH = H - cropT - cropB;
      const canvas = document.createElement('canvas');
      canvas.width  = finalW;
      canvas.height = finalH;
      const ctx = canvas.getContext('2d')!;

      ctx.drawImage(
        tmp,
        padX + cropL,  // fuente X
        padY + cropT,  // fuente Y
        finalW,        // fuente ancho
        finalH,        // fuente alto
        0, 0, finalW, finalH,
      );

      // ── 6. Brillo / contraste / ruido por píxel ─────────────────────────
      const brightness = rnd(cfg.brightness[0], cfg.brightness[1]);
      const contrast   = rnd(cfg.contrast[0],   cfg.contrast[1]);

      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imgData.data;

      for (let i = 0; i < d.length; i += 4) {
        const nr = rndInt(-cfg.noise, cfg.noise);
        const ng = rndInt(-cfg.noise, cfg.noise);
        const nb = rndInt(-cfg.noise, cfg.noise);
        d[i]   = clamp((d[i]   - 128) * contrast + 128 + brightness + nr);
        d[i+1] = clamp((d[i+1] - 128) * contrast + 128 + brightness + ng);
        d[i+2] = clamp((d[i+2] - 128) * contrast + 128 + brightness + nb);
      }
      ctx.putImageData(imgData, 0, 0);

      // ── 7. Exportar ──────────────────────────────────────────────────────
      const quality = rnd(cfg.quality[0], cfg.quality[1]);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      const size    = Math.round((dataUrl.split(',')[1].length * 3) / 4);

      const techniques: Techniques = {
        crop:       `Recorte ${cropT}↑ ${cropB}↓ ${cropL}← ${cropR}→ px`,
        rotation:   `Rotación ${rotDeg > 0 ? '+' : ''}${rotDeg.toFixed(2)}°`,
        skew:       `Ángulo cámara: H${skewXDeg > 0 ? '+' : ''}${skewXDeg.toFixed(1)}° / V${skewYDeg > 0 ? '+' : ''}${skewYDeg.toFixed(1)}°`,
        noise:      `Ruido pixel ±${cfg.noise} por canal RGB`,
        brightness: `Brillo ${brightness > 0 ? '+' : ''}${brightness.toFixed(1)}`,
        contrast:   `Contraste ×${contrast.toFixed(3)}`,
        quality:    `JPEG ${Math.round(quality * 100)}% calidad`,
      };

      resolve({ dataUrl, size, techniques });
    };

    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

function formatSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function dl(dataUrl: string, name: string) {
  const a = document.createElement('a');
  a.href = dataUrl; a.download = name; a.click();
}

// ─── Componente ──────────────────────────────────────────────────────────────

export default function ImageUniquifier() {
  const [intensity, setIntensity]   = useState<Intensity>('normal');
  const [images, setImages]         = useState<ProcessedImage[]>([]);
  const [dragging, setDragging]     = useState(false);
  const [processing, setProcessing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback(async (files: File[]) => {
    const valid = files.filter(f => f.type.startsWith('image/'));
    if (!valid.length) return;
    setProcessing(true);

    const entries: ProcessedImage[] = valid.map(f => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file: f,
      originalUrl:   URL.createObjectURL(f),
      processedUrl:  null,
      originalSize:  f.size,
      processedSize: 0,
      status:        'processing',
      techniques:    null,
      showOriginal:  false,
    }));

    setImages(prev => [...entries, ...prev]);

    for (const entry of entries) {
      try {
        const { dataUrl, size, techniques } = await uniquifyImage(entry.file, intensity);
        setImages(prev => prev.map(img =>
          img.id === entry.id
            ? { ...img, processedUrl: dataUrl, processedSize: size, status: 'done', techniques }
            : img,
        ));
      } catch {
        setImages(prev => prev.map(img =>
          img.id === entry.id ? { ...img, status: 'error' } : img,
        ));
      }
    }
    setProcessing(false);
  }, [intensity]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    processFiles(Array.from(e.dataTransfer.files));
  };

  const onInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  const regenerate = async (id: string) => {
    const img = images.find(i => i.id === id);
    if (!img) return;
    setImages(prev => prev.map(i =>
      i.id === id ? { ...i, status: 'processing', processedUrl: null } : i,
    ));
    try {
      const { dataUrl, size, techniques } = await uniquifyImage(img.file, intensity);
      setImages(prev => prev.map(i =>
        i.id === id ? { ...i, processedUrl: dataUrl, processedSize: size, status: 'done', techniques } : i,
      ));
    } catch {
      setImages(prev => prev.map(i =>
        i.id === id ? { ...i, status: 'error' } : i,
      ));
    }
  };

  const togglePreview = (id: string) =>
    setImages(prev => prev.map(i => i.id === id ? { ...i, showOriginal: !i.showOriginal } : i));

  const remove = (id: string) => setImages(prev => prev.filter(i => i.id !== id));

  const downloadAll = () => {
    images
      .filter(i => i.status === 'done' && i.processedUrl)
      .forEach((img, idx) => {
        const name = img.file.name.replace(/\.[^.]+$/, `_unique_${idx + 1}.jpg`);
        setTimeout(() => dl(img.processedUrl!, name), idx * 150);
      });
  };

  const doneCount = images.filter(i => i.status === 'done').length;
  const cfg = INTENSITY_CONFIG[intensity];

  return (
    <div className="space-y-6">

      {/* ── Selector de intensidad ─────────────────────────────────────────── */}
      <div className="space-y-3">
        <p className="text-xs uppercase tracking-widest text-white/30 font-bold">Nivel de evasión</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {(Object.keys(INTENSITY_CONFIG) as Intensity[]).map(lvl => {
            const c      = INTENSITY_CONFIG[lvl];
            const active = intensity === lvl;
            return (
              <button
                key={lvl}
                onClick={() => setIntensity(lvl)}
                className={`relative flex flex-col items-center gap-1 px-3 py-4 rounded-2xl border text-center transition-all ${
                  active
                    ? `${c.bg} border-opacity-100`
                    : 'bg-white/[0.02] border-white/5 hover:bg-white/5'
                }`}
              >
                <span className={`text-sm font-black uppercase tracking-wider ${active ? c.color : 'text-white/40'}`}>
                  {c.label}
                </span>
                <span className="text-[10px] text-white/30 leading-tight">{c.desc}</span>
                {active && (
                  <div className={`absolute top-2 right-2 w-1.5 h-1.5 rounded-full ${c.color.replace('text-', 'bg-')}`} />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Panel de técnicas ─────────────────────────────────────────────── */}
      <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-4 space-y-2">
        <p className="text-xs font-bold text-white/50 uppercase tracking-widest mb-3">
          7 técnicas aplicadas — nivel {cfg.label}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-white/40">
          <div className="flex items-start gap-2">
            <span className={`font-bold shrink-0 ${cfg.color}`}>✓</span>
            <span>
              <strong className="text-white/60">Recorte + resize</strong>
              {' '}— {cfg.crop[0]}–{cfg.crop[1]}px por borde y reescala. Rompe pHash completamente.
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className={`font-bold shrink-0 ${cfg.color}`}>✓</span>
            <span>
              <strong className="text-white/60">Micro-rotación</strong>
              {' '}— ±{cfg.rotation}° con compensación de escala. Sin bordes negros.
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className={`font-bold shrink-0 ${cfg.color}`}>✓</span>
            <span>
              <strong className="text-white/60 flex items-center gap-1">
                <Camera className="w-3 h-3 inline" /> Ángulo de cámara
              </strong>
              {' '}— skew ±{cfg.skew}° H / ±{(cfg.skew / 2).toFixed(1)}° V. Simula foto desde posición diferente. Derrota CNN/IA.
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className={`font-bold shrink-0 ${cfg.color}`}>✓</span>
            <span>
              <strong className="text-white/60">Ruido por píxel</strong>
              {' '}— ±{cfg.noise} por canal RGB. Cambia MD5/SHA al 100%.
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className={`font-bold shrink-0 ${cfg.color}`}>✓</span>
            <span>
              <strong className="text-white/60">Brillo + contraste</strong>
              {' '}— variación aleatoria. Cambia histograma de color.
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className={`font-bold shrink-0 ${cfg.color}`}>✓</span>
            <span>
              <strong className="text-white/60">JPEG variable</strong>
              {' '}— calidad {Math.round(cfg.quality[0] * 100)}–{Math.round(cfg.quality[1] * 100)}%. Cambia artefactos de compresión.
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className={`font-bold shrink-0 ${cfg.color}`}>✓</span>
            <span>
              <strong className="text-white/60">Sin EXIF</strong>
              {' '}— GPS, fecha, cámara, software. Todo eliminado por Canvas API.
            </span>
          </div>
        </div>
      </div>

      {/* ── Zona de subida ────────────────────────────────────────────────── */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        className={`border-2 border-dashed rounded-3xl p-10 text-center cursor-pointer transition-all ${
          dragging
            ? 'border-emerald-500 bg-emerald-500/5 scale-[1.01]'
            : 'border-white/10 hover:border-white/20 hover:bg-white/[0.02]'
        }`}
      >
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onInput} />
        <Upload className={`w-8 h-8 mx-auto mb-3 ${dragging ? 'text-emerald-400' : 'text-white/20'}`} />
        <p className="text-white font-semibold">Arrastra tus fotos aquí</p>
        <p className="text-white/30 text-sm mt-1">Múltiples imágenes · JPG, PNG, WEBP</p>
        <p className="text-white/20 text-xs mt-3">
          Todo el proceso ocurre en tu navegador — las imágenes nunca se suben a ningún servidor
        </p>
      </div>

      {/* ── Barra de acciones ─────────────────────────────────────────────── */}
      {images.length > 0 && (
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${processing ? 'bg-amber-400 animate-pulse' : 'bg-emerald-500'}`} />
            <span className="text-sm text-white/50">
              {processing
                ? 'Procesando...'
                : <><span className="text-white font-bold">{doneCount}</span>/{images.length} procesadas</>
              }
            </span>
          </div>
          <div className="flex gap-2">
            {doneCount > 0 && (
              <button
                onClick={downloadAll}
                className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-black font-bold px-4 py-2 rounded-xl text-sm transition"
              >
                <Package className="w-4 h-4" />
                Descargar todas ({doneCount})
              </button>
            )}
            <button
              onClick={() => setImages([])}
              className="flex items-center gap-2 bg-white/5 hover:bg-red-500/10 text-white/40 hover:text-red-400 border border-white/10 hover:border-red-500/20 px-4 py-2 rounded-xl text-sm transition"
            >
              <Trash2 className="w-4 h-4" />
              Limpiar
            </button>
          </div>
        </div>
      )}

      {/* ── Grid de imágenes ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <AnimatePresence>
          {images.map(img => (
            <motion.div
              key={img.id}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-[#141414] border border-white/5 rounded-2xl overflow-hidden"
            >
              {/* Preview */}
              <div className="relative aspect-square bg-black/60 flex items-center justify-center overflow-hidden">
                {img.status === 'processing' && (
                  <div className="flex flex-col items-center gap-2 text-white/30">
                    <RefreshCcw className="w-8 h-8 animate-spin text-emerald-400" />
                    <span className="text-xs">Procesando…</span>
                  </div>
                )}
                {img.status === 'error' && (
                  <div className="flex flex-col items-center gap-2 text-red-400/60">
                    <ZapOff className="w-8 h-8" />
                    <span className="text-xs">Error al procesar</span>
                  </div>
                )}
                {img.status === 'done' && (
                  <>
                    <img
                      src={img.showOriginal ? img.originalUrl : img.processedUrl!}
                      alt={img.file.name}
                      className="w-full h-full object-cover"
                    />
                    <div className={`absolute top-2 left-2 text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${
                      img.showOriginal ? 'bg-white/20 text-white' : 'bg-emerald-500 text-black'
                    }`}>
                      {img.showOriginal ? 'Original' : 'Único ✓'}
                    </div>
                  </>
                )}
              </div>

              {/* Info */}
              <div className="p-4 space-y-3">
                <p className="text-xs text-white/60 truncate font-medium">{img.file.name}</p>

                {img.status === 'done' && img.techniques && (
                  <div className="space-y-1">
                    {Object.values(img.techniques).map((t, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-[10px] text-white/30">
                        <span className={`w-1 h-1 rounded-full shrink-0 ${cfg.color.replace('text-', 'bg-')}`} />
                        {t}
                      </div>
                    ))}
                    <div className="flex justify-between text-[10px] pt-1 border-t border-white/5 mt-2">
                      <span className="text-white/20">Original: {formatSize(img.originalSize)}</span>
                      <span className="text-white/20">Único: {formatSize(img.processedSize)}</span>
                    </div>
                  </div>
                )}

                {/* Botones */}
                <div className="flex gap-2">
                  {img.status === 'done' && img.processedUrl && (
                    <>
                      <button
                        onClick={() => dl(img.processedUrl!, img.file.name.replace(/\.[^.]+$/, '_unique.jpg'))}
                        className="flex-1 flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-black font-bold py-2 rounded-xl text-xs transition"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Descargar
                      </button>
                      <button
                        onClick={() => togglePreview(img.id)}
                        title={img.showOriginal ? 'Ver versión única' : 'Ver original'}
                        className="p-2 bg-white/5 hover:bg-white/10 text-white/40 hover:text-white rounded-xl border border-white/5 transition"
                      >
                        {img.showOriginal ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                      </button>
                    </>
                  )}
                  {(img.status === 'done' || img.status === 'error') && (
                    <button
                      onClick={() => regenerate(img.id)}
                      title="Regenerar con nuevos valores aleatorios"
                      className="p-2 bg-white/5 hover:bg-white/10 text-white/40 hover:text-emerald-400 rounded-xl border border-white/5 transition"
                    >
                      <Shuffle className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => remove(img.id)}
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

      {images.length === 0 && (
        <p className="text-center text-white/15 text-sm py-4">
          Sube las mismas fotos una y otra vez — cada vez saldrán completamente diferentes para cualquier sistema de detección
        </p>
      )}
    </div>
  );
}
