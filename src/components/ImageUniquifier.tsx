import React, { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Upload, Download, Image as ImageIcon,
  CheckCircle2, RefreshCcw, Trash2, Shuffle,
  ZapOff, Images
} from 'lucide-react';

// ─── Config única ────────────────────────────────────────────────────────────
//
// Técnicas aplicadas (todas sub-visuales):
//  🎯 Flip horizontal 50%    — embedding CNN completamente distinto
//  🎯 EXIF aleatorio realista — iPhone/Samsung/Pixel + fecha + ISO + focal
//  ✓  Crop simétrico 3-8%    — porcentaje TOTAL repartido en 4 bordes iguales
//  ✓  Aspect ratio ±2%       — variación mínima de proporciones
//  ✓  Perspective warp ±5px  — esquinas levemente desplazadas hacia dentro
//  ✓  Ruido por bloques 16×16— estadísticas por parche distintas, invisible
//  ✓  Ondulación sinusoidal ±1px — layout espacial único
//  ✓  Micro-rotación ±0.3°   — sub-milimétrica
//  ✓  Brillo + gradiente ±3  — sub-visual, sin cambio de color
//  ✓  JPEG variable 87-93%   — artefactos de compresión únicos

const CFG = {
  // Crop simétrico: % TOTAL del ancho/alto, dividido en 4 bordes iguales.
  // 3% total → 1.5% por borde → en 800px = 12px por lado. Apenas visible.
  // 8% total → 4% por borde  → en 800px = 32px por lado. Sigue presentable.
  cropPctMin: 3.0,
  cropPctMax: 8.0,

  // Ruido por bloques 16×16 ±2 (invisible al ojo humano)
  blockNoiseMax: 2,
  blockSize: 16,

  // Sinusoidal ±1px (desplazamiento sub-píxel en pantalla normal)
  lineWarpMax: 1,

  // Micro-rotación ±0.3°
  rotateDegMax: 0.3,

  // Brillo ±3 y gradiente ±3 (sub-visual, sin tinte de color)
  brightMax: 3,
  gradientMax: 3,

  // JPEG 87-93%
  qualityMin: 0.87,
  qualityMax: 0.93,

  // Flip horizontal 50% (cambia el embedding CNN por completo)
  flipChance: 0.5,

  // Aspect ratio ±2%
  aspectStretchMax: 0.02,

  // Perspective warp ±5px hacia dentro (NO crea bordes negros)
  perspectiveMax: 5,

  // EXIF aleatorio (metadata pura, cero cambio visual)
  randomExif: true,

  // Deshabilitado: ruido per-pixel (visible), bgShift (cambia colores), texturas, distractores
  trimMin: 0, trimMax: 0,
  pixelNoiseMax: 0,
  bgShiftMax: 0, bgTolerance: 0,
  textureAmp: 0,
  offCenterKeepMin: 0, offCenterKeepMax: 0,
  toneCurveAmp: 0,
  distractorChance: 0,
};

const TECHNIQUES = [
  { icon: '🎯', title: 'Flip horizontal 50%', detail: 'Espejo aleatorio. Embedding CNN completamente distinto.' },
  { icon: '🎯', title: 'EXIF aleatorio realista', detail: 'iPhone/Samsung/Pixel + fecha + ISO + focal. Parece tomada con móvil.' },
  { icon: '✓',  title: 'Crop simétrico 3-8%', detail: 'Recorte en los 4 bordes por igual. Encuadre preservado.' },
  { icon: '✓',  title: 'Aspect ratio ±2%', detail: 'Variación mínima de proporciones, imperceptible.' },
  { icon: '✓',  title: 'Perspective warp ±5px', detail: 'Esquinas desplazadas hacia dentro. Geometría única.' },
  { icon: '✓',  title: 'Ruido por bloques 16×16', detail: 'Cada parche del ViT ve estadísticas distintas, invisible al ojo.' },
  { icon: '✓',  title: 'Ondulación sinusoidal ±1px', detail: 'Layout espacial único por imagen.' },
  { icon: '✓',  title: 'Micro-rotación ±0.3°', detail: 'Sub-milimétrica, invisible.' },
  { icon: '✓',  title: 'Brillo + gradiente ±3', detail: 'Sub-visual. Sin cambio de color.' },
  { icon: '✓',  title: 'JPEG variable 87-93%', detail: 'Artefactos de compresión únicos.' },
];

// ─── Motor principal ──────────────────────────────────────────────────────────

async function uniquifyImage(
  file: File
): Promise<{ dataUrl: string; dimChange: string; size: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = async () => {
        const rnd  = (a: number, b: number) => a + Math.random() * (b - a);
        const rndI = (a: number, b: number) => Math.floor(rnd(a, b + 1));
        const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));

        const IW = img.width, IH = img.height;

        // ── 1. Crop SIMÉTRICO (derrota pHash) ────────────────────────────
        // totalPct = % total del ancho/alto a recortar, repartido en 4 bordes iguales.
        // Ej: totalPct=0.06 → cx = 3% del ancho por cada lado → producto centrado.
        let srcX = 0, srcY = 0, srcW = IW, srcH = IH;
        {
          const totalPct = rnd(CFG.cropPctMin, CFG.cropPctMax) / 100;
          const cx = Math.floor(IW * totalPct / 2);
          const cy = Math.floor(IH * totalPct / 2);
          srcX = cx; srcY = cy;
          srcW = Math.max(IW - cx * 2, 1);
          srcH = Math.max(IH - cy * 2, 1);
        }

        // ── 2. Dimensiones finales con aspect stretch ─────────────────────
        let W = srcW, H = srcH;
        if (CFG.aspectStretchMax > 0) {
          const wS = 1 + rnd(-CFG.aspectStretchMax, CFG.aspectStretchMax);
          const hS = 1 + rnd(-CFG.aspectStretchMax, CFG.aspectStretchMax);
          W = Math.max(1, Math.round(W * wS));
          H = Math.max(1, Math.round(H * hS));
        }

        // ── 3. Flip + micro-rotación ──────────────────────────────────────
        const flipH = Math.random() < CFG.flipChance;

        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d')!;

        ctx.save();
        if (flipH) {
          ctx.translate(W, 0);
          ctx.scale(-1, 1);
        }
        if (CFG.rotateDegMax > 0) {
          const angle = rnd(-CFG.rotateDegMax, CFG.rotateDegMax) * Math.PI / 180;
          const cos = Math.cos(angle), sin = Math.sin(angle);
          const scale = 1 / (Math.abs(cos) + Math.abs(sin));
          ctx.translate(W / 2, H / 2);
          ctx.rotate(angle);
          ctx.scale(scale, scale);
          ctx.translate(-W / 2, -H / 2);
        }
        ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, W, H);
        ctx.restore();

        // ── 4. Perspective warp (esquinas hacia DENTRO, sin bordes negros) ─
        {
          const pAmp = CFG.perspectiveMax;
          const dTLx = rnd(0, pAmp),  dTLy = rnd(0, pAmp);
          const dTRx = rnd(-pAmp, 0), dTRy = rnd(0, pAmp);
          const dBLx = rnd(0, pAmp),  dBLy = rnd(-pAmp, 0);
          const dBRx = rnd(-pAmp, 0), dBRy = rnd(-pAmp, 0);
          const srcP = ctx.getImageData(0, 0, W, H);
          const dstP = ctx.createImageData(W, H);
          const sd = srcP.data, dd = dstP.data;
          const wm1 = W - 1, hm1 = H - 1;
          for (let y = 0; y < H; y++) {
            const v = hm1 > 0 ? y / hm1 : 0;
            const inv1v = 1 - v;
            for (let x = 0; x < W; x++) {
              const u = wm1 > 0 ? x / wm1 : 0;
              const w00 = (1 - u) * inv1v, w10 = u * inv1v;
              const w01 = (1 - u) * v,     w11 = u * v;
              const sx = x + w00*dTLx + w10*dTRx + w01*dBLx + w11*dBRx;
              const sy = y + w00*dTLy + w10*dTRy + w01*dBLy + w11*dBRy;
              const fxi = Math.floor(sx), fyi = Math.floor(sy);
              const x0 = Math.max(0, Math.min(fxi, wm1));
              const y0 = Math.max(0, Math.min(fyi, hm1));
              const x1 = Math.min(x0 + 1, wm1);
              const y1 = Math.min(y0 + 1, hm1);
              const fx = Math.max(0, Math.min(sx - fxi, 1));
              const fy = Math.max(0, Math.min(sy - fyi, 1));
              const ifx = 1 - fx, ify = 1 - fy;
              const i00 = (y0*W+x0)*4, i10 = (y0*W+x1)*4;
              const i01 = (y1*W+x0)*4, i11 = (y1*W+x1)*4;
              const di  = (y*W+x)*4;
              dd[di]   = (sd[i00]  *ifx + sd[i10]  *fx)*ify + (sd[i01]  *ifx + sd[i11]  *fx)*fy;
              dd[di+1] = (sd[i00+1]*ifx + sd[i10+1]*fx)*ify + (sd[i01+1]*ifx + sd[i11+1]*fx)*fy;
              dd[di+2] = (sd[i00+2]*ifx + sd[i10+2]*fx)*ify + (sd[i01+2]*ifx + sd[i11+2]*fx)*fy;
              dd[di+3] = 255;
            }
          }
          ctx.putImageData(dstP, 0, 0);
        }

        // ── 5. Ondulación sinusoidal por filas ±1px ───────────────────────
        {
          const warpFreq  = rnd(0.8, 2.5);
          const warpPhase = rnd(0, Math.PI * 2);
          const src2 = ctx.getImageData(0, 0, W, H);
          const dst2 = ctx.createImageData(W, H);
          for (let y = 0; y < H; y++) {
            const offset = Math.round(CFG.lineWarpMax * Math.sin(y / H * warpFreq * 2 * Math.PI + warpPhase));
            for (let x = 0; x < W; x++) {
              const srcXw = Math.min(W-1, Math.max(0, x - offset));
              const si = (y*W + srcXw)*4, di = (y*W + x)*4;
              dst2.data[di]   = src2.data[si];
              dst2.data[di+1] = src2.data[si+1];
              dst2.data[di+2] = src2.data[si+2];
              dst2.data[di+3] = src2.data[si+3];
            }
          }
          ctx.putImageData(dst2, 0, 0);
        }

        // ── 6. Ruido por bloques 16×16 + brillo + gradiente ──────────────
        const imageData = ctx.getImageData(0, 0, W, H);
        const data = imageData.data;

        const bright  = rnd(-CFG.brightMax, CFG.brightMax);
        const gradAmt = rnd(-CFG.gradientMax, CFG.gradientMax);

        // Ruido por bloques (invisible al ojo, derrota patches CNN)
        {
          const bSize = CFG.blockSize;
          const bCols = Math.ceil(W / bSize);
          const bRows = Math.ceil(H / bSize);
          const blockOffsets = new Int16Array(bRows * bCols);
          for (let k = 0; k < blockOffsets.length; k++) {
            blockOffsets[k] = rndI(-CFG.blockNoiseMax, CFG.blockNoiseMax);
          }
          for (let y = 0; y < H; y++) {
            const by = Math.floor(y / bSize);
            for (let x = 0; x < W; x++) {
              const bOff = blockOffsets[by * bCols + Math.floor(x / bSize)];
              if (bOff === 0) continue;
              const i = (y*W+x)*4;
              data[i]   = clamp(data[i]   + bOff);
              data[i+1] = clamp(data[i+1] + bOff);
              data[i+2] = clamp(data[i+2] + bOff);
            }
          }
        }

        // Brillo global + gradiente diagonal (sin tinte de color)
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = (y*W+x)*4;
            let delta = bright;
            if (gradAmt !== 0) delta += gradAmt * ((x/W + y/H) / 2 - 0.5);
            if (delta !== 0) {
              data[i]   = clamp(data[i]   + delta);
              data[i+1] = clamp(data[i+1] + delta);
              data[i+2] = clamp(data[i+2] + delta);
            }
          }
        }

        ctx.putImageData(imageData, 0, 0);

        // ── 7. JPEG variable 87-93% ───────────────────────────────────────
        const quality = rnd(CFG.qualityMin, CFG.qualityMax);
        let dataUrl = canvas.toDataURL('image/jpeg', quality);

        // ── 8. EXIF aleatorio realista (metadata pura, cero visual) ───────
        try {
          const { injectRandomExif } = await import('../lib/randomExif');
          dataUrl = await injectRandomExif(dataUrl);
        } catch (e) {
          console.warn('[uniquify] EXIF skipped:', e);
        }

        const size = Math.round((dataUrl.split(',')[1].length * 3) / 4);
        resolve({ dataUrl, dimChange: `${IW}×${IH} → ${W}×${H}`, size });
      };
      img.onerror = reject;
      img.src = e.target!.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024*1024) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/(1024*1024)).toFixed(2)} MB`;
}

const IS_MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// Convierte un data URL a Blob sin hacer fetch (evita bloqueo CSP connect-src)
function dataUrlToBlob(dataUrl: string): Blob {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] ?? 'image/jpeg';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function dl(dataUrl: string, name: string): Promise<void> {
  const blob    = dataUrlToBlob(dataUrl);
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 5_000);
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

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProcessedImage {
  id: string;
  originalName: string;
  originalUrl: string;
  processedUrl: string | null;
  originalSize: number;
  processedSize: number;
  status: 'processing' | 'done' | 'error';
  dimChange: string;
}

// ─── Componente ───────────────────────────────────────────────────────────────

export default function ImageUniquifier() {
  const [images, setImages]     = useState<ProcessedImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!arr.length) return;

    const entries: ProcessedImage[] = arr.map(f => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      originalName: f.name,
      originalUrl: URL.createObjectURL(f),
      processedUrl: null,
      originalSize: f.size,
      processedSize: 0,
      status: 'processing',
      dimChange: '',
    }));
    setImages(prev => [...entries, ...prev]);

    for (let i = 0; i < arr.length; i++) {
      const entry = entries[i];
      try {
        const res = await uniquifyImage(arr[i]);
        setImages(prev => prev.map(img =>
          img.id === entry.id
            ? { ...img, processedUrl: res.dataUrl, processedSize: res.size, status: 'done', dimChange: res.dimChange }
            : img
        ));
      } catch (e) {
        console.error('[uniquify] error', e);
        setImages(prev => prev.map(img => img.id === entry.id ? { ...img, status: 'error' } : img));
      }
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false); processFiles(e.dataTransfer.files);
  }, [processFiles]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(e.target.files);
    e.target.value = '';
  };

  const reprocess = async (id: string) => {
    const entry = images.find(img => img.id === id); if (!entry) return;
    setImages(prev => prev.map(img => img.id === id ? { ...img, status: 'processing', processedUrl: null } : img));
    try {
      const blob = await fetch(entry.originalUrl).then(r => r.blob());
      const file = new File([blob], entry.originalName, { type: 'image/jpeg' });
      const res  = await uniquifyImage(file);
      setImages(prev => prev.map(img =>
        img.id === id
          ? { ...img, processedUrl: res.dataUrl, processedSize: res.size, status: 'done', dimChange: res.dimChange }
          : img
      ));
    } catch {
      setImages(prev => prev.map(img => img.id === id ? { ...img, status: 'error' } : img));
    }
  };

  const handleSaveAll = async () => {
    const done = images.filter(i => i.status === 'done' && i.processedUrl);
    if (!done.length) return;
    setSavingAll(true); setSavedCount(0);
    const items = done.map((img, idx) => ({
      dataUrl: img.processedUrl!,
      filename: `${img.originalName.replace(/\.[^.]+$/, '')}_unique_${idx + 1}.jpg`,
    }));
    try { await saveAll(items, (n) => setSavedCount(n)); }
    finally { setSavingAll(false); }
  };

  const handleSaveOne = (dataUrl: string, originalName: string) => {
    dl(dataUrl, originalName.replace(/\.[^.]+$/, '_unique.jpg'));
  };

  const remove    = (id: string) => setImages(prev => prev.filter(i => i.id !== id));
  const clearAll  = () => setImages([]);
  const doneCount = images.filter(i => i.status === 'done').length;

  const saveLabel    = IS_MOBILE ? 'Guardar' : 'Descargar';
  const saveAllLabel = IS_MOBILE ? 'Guardar en galería' : 'Descargar todas';

  return (
    <div className="space-y-6">

      {/* Técnicas aplicadas */}
      <div className="bg-[#111] border border-white/[0.08] rounded-2xl p-5 space-y-3">
        <p className="text-xs font-black uppercase tracking-widest text-white/50">
          {TECHNIQUES.length} técnicas — imagen visualmente idéntica al original
        </p>
        <div className="space-y-2">
          {TECHNIQUES.map((t, i) => (
            <div key={i} className="flex gap-3">
              <span className="text-sm shrink-0 mt-0.5 text-acid">{t.icon}</span>
              <p className="text-[12px] text-white/70 leading-snug">
                <span className="font-bold text-white/90">{t.title}</span>
                {' — '}{t.detail}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Drop Zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`relative border-2 border-dashed rounded-3xl p-10 text-center cursor-pointer transition-all ${
          dragging ? 'border-acid bg-acid-soft scale-[1.01]' : 'border-white/10 hover:border-white/20 hover:bg-white/[0.02]'
        }`}
      >
        <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileInput} />
        <div className="flex flex-col items-center gap-3">
          <div className={`w-16 h-16 rounded-2xl flex items-center justify-center border transition-all ${
            dragging ? 'bg-acid-soft border-acid' : 'bg-white/5 border-white/10'
          }`}>
            <Upload className={`w-7 h-7 ${dragging ? 'text-acid' : 'text-white/40'}`} />
          </div>
          <div>
            <p className="text-white font-semibold">Arrastra las fotos del producto aquí</p>
            <p className="text-white/40 text-sm mt-1">Cada foto procesada es 100% única · Colores sin cambios</p>
          </div>
        </div>
      </div>

      {/* Barra acciones */}
      {images.length > 0 && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm text-white/50">
            <span className="text-white font-bold">{doneCount}</span>/{images.length} procesadas
            {savingAll && savedCount > 0 && (
              <span className="ml-2 text-acid font-bold">· Guardadas {savedCount}</span>
            )}
          </p>
          <div className="flex gap-2">
            {doneCount > 0 && (
              <button
                onClick={handleSaveAll}
                disabled={savingAll}
                className="flex items-center gap-2 bg-acid hover:bg-acid disabled:opacity-60 text-black font-bold px-4 py-2 rounded-xl text-sm transition"
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

      {/* Grid imágenes */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <AnimatePresence>
          {images.map(img => (
            <motion.div key={img.id}
              initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9 }}
              className="bg-[#141414] border border-white/5 rounded-2xl overflow-hidden">
              <div className="relative aspect-square bg-black/40 flex items-center justify-center overflow-hidden">
                {img.processedUrl
                  ? <img src={img.processedUrl} alt={img.originalName} className="w-full h-full object-cover" />
                  : img.status === 'processing'
                  ? <div className="flex flex-col items-center gap-3">
                      <RefreshCcw className="w-8 h-8 animate-spin text-acid" />
                      <span className="text-xs text-white/30">Procesando…</span>
                    </div>
                  : img.status === 'error'
                  ? <div className="flex flex-col items-center gap-2 text-red-400/60">
                      <ZapOff className="w-8 h-8" />
                      <span className="text-xs">Error</span>
                    </div>
                  : <ImageIcon className="w-12 h-12 text-white/10" />
                }
                {img.status === 'done' && (
                  <div className="absolute top-2 right-2 bg-acid rounded-full p-1">
                    <CheckCircle2 className="w-3.5 h-3.5 text-black" />
                  </div>
                )}
              </div>
              <div className="p-4 space-y-3">
                <p className="text-xs text-white/70 truncate font-medium">{img.originalName}</p>
                {img.status === 'done' && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-white/30"><span>Original</span><span className="font-mono">{formatSize(img.originalSize)}</span></div>
                    <div className="flex justify-between text-[10px] text-acid"><span>Procesada</span><span className="font-mono">{formatSize(img.processedSize)}</span></div>
                    <div className="text-[10px] text-white/20 font-mono mt-1">{img.dimChange}</div>
                  </div>
                )}
                <div className="flex gap-2">
                  {img.status === 'done' && img.processedUrl && (
                    <button
                      onClick={() => handleSaveOne(img.processedUrl!, img.originalName)}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-acid hover:bg-acid text-black font-bold py-2 rounded-xl text-xs transition"
                    >
                      <Download className="w-3.5 h-3.5" />{saveLabel}
                    </button>
                  )}
                  {(img.status === 'done' || img.status === 'error') && (
                    <button onClick={() => reprocess(img.id)} title="Regenerar versión diferente"
                      className="p-2 bg-white/5 hover:bg-white/10 text-white/40 hover:text-acid rounded-xl border border-white/5 transition">
                      <Shuffle className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button onClick={() => remove(img.id)}
                    className="p-2 bg-white/5 hover:bg-red-500/10 text-white/20 hover:text-red-400 rounded-xl border border-white/5 transition">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {images.length === 0 && (
        <p className="text-center py-4 text-white/20 text-sm">
          Sube las fotos del producto y procésalas para cada cuenta de Vinted
        </p>
      )}
    </div>
  );
}
