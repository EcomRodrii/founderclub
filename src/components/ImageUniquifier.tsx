import React, { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Upload, Download, Image as ImageIcon,
  CheckCircle2, RefreshCcw, Trash2, Shuffle,
  ZapOff, Package
} from 'lucide-react';

interface ProcessedImage {
  id: string;
  originalName: string;
  originalUrl: string;
  processedUrl: string | null;
  originalSize: number;
  processedSize: number;
  status: 'processing' | 'done' | 'error';
  noiseLevel: number;
  dimChange: string;
}

async function uniquifyImage(file: File): Promise<{ dataUrl: string; noiseLevel: number; dimChange: string; size: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // 1. Random dimension shrink 1–4px (changes hash + defeats perceptual hash)
        const shrinkW = Math.floor(Math.random() * 4) + 1;
        const shrinkH = Math.floor(Math.random() * 4) + 1;
        const w = Math.max(img.width - shrinkW, 1);
        const h = Math.max(img.height - shrinkH, 1);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;

        // 2. Draw image (this strips ALL EXIF metadata automatically)
        ctx.drawImage(img, 0, 0, w, h);

        // 3. Add invisible ±2 pixel noise per channel
        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;
        const noiseLevel = Math.round(Math.random() * 2) + 1; // 1-3
        for (let i = 0; i < data.length; i += 4) {
          data[i]   = Math.min(255, Math.max(0, data[i]   + Math.round(Math.random() * noiseLevel * 2 - noiseLevel)));
          data[i+1] = Math.min(255, Math.max(0, data[i+1] + Math.round(Math.random() * noiseLevel * 2 - noiseLevel)));
          data[i+2] = Math.min(255, Math.max(0, data[i+2] + Math.round(Math.random() * noiseLevel * 2 - noiseLevel)));
          // Alpha channel unchanged
        }
        ctx.putImageData(imageData, 0, 0);

        // 4. Random JPEG quality 0.88–0.95 (further changes the binary hash)
        const quality = 0.88 + Math.random() * 0.07;
        const dataUrl = canvas.toDataURL('image/jpeg', quality);

        // Calculate approximate size
        const base64 = dataUrl.split(',')[1];
        const size = Math.round((base64.length * 3) / 4);

        resolve({
          dataUrl,
          noiseLevel,
          dimChange: `${img.width}×${img.height} → ${w}×${h}`,
          size,
        });
      };
      img.onerror = reject;
      img.src = e.target!.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

export default function ImageUniquifier() {
  const [images, setImages] = useState<ProcessedImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!fileArray.length) return;

    const newEntries: ProcessedImage[] = fileArray.map(f => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      originalName: f.name,
      originalUrl: URL.createObjectURL(f),
      processedUrl: null,
      originalSize: f.size,
      processedSize: 0,
      status: 'processing',
      noiseLevel: 0,
      dimChange: '',
    }));

    setImages(prev => [...newEntries, ...prev]);

    // Process each image async
    for (let i = 0; i < fileArray.length; i++) {
      const entry = newEntries[i];
      try {
        const { dataUrl, noiseLevel, dimChange, size } = await uniquifyImage(fileArray[i]);
        setImages(prev => prev.map(img =>
          img.id === entry.id
            ? { ...img, processedUrl: dataUrl, processedSize: size, status: 'done', noiseLevel, dimChange }
            : img
        ));
      } catch {
        setImages(prev => prev.map(img =>
          img.id === entry.id ? { ...img, status: 'error' } : img
        ));
      }
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    processFiles(e.dataTransfer.files);
  }, [processFiles]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(e.target.files);
    e.target.value = '';
  };

  const reprocess = async (id: string) => {
    const entry = images.find(img => img.id === id);
    if (!entry || !entry.originalUrl) return;

    setImages(prev => prev.map(img => img.id === id ? { ...img, status: 'processing', processedUrl: null } : img));

    try {
      const blob = await fetch(entry.originalUrl).then(r => r.blob());
      const file = new File([blob], entry.originalName, { type: 'image/jpeg' });
      const { dataUrl, noiseLevel, dimChange, size } = await uniquifyImage(file);
      setImages(prev => prev.map(img =>
        img.id === id
          ? { ...img, processedUrl: dataUrl, processedSize: size, status: 'done', noiseLevel, dimChange }
          : img
      ));
    } catch {
      setImages(prev => prev.map(img => img.id === id ? { ...img, status: 'error' } : img));
    }
  };

  const downloadAll = () => {
    const done = images.filter(img => img.status === 'done' && img.processedUrl);
    done.forEach((img, i) => {
      const ext = img.originalName.replace(/\.[^.]+$/, '');
      setTimeout(() => downloadDataUrl(img.processedUrl!, `${ext}_unique_${i + 1}.jpg`), i * 100);
    });
  };

  const remove = (id: string) => {
    setImages(prev => prev.filter(img => img.id !== id));
  };

  const clearAll = () => setImages([]);

  const doneCount = images.filter(i => i.status === 'done').length;

  return (
    <div className="space-y-6">
      {/* Drop Zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`relative border-2 border-dashed rounded-3xl p-10 text-center cursor-pointer transition-all ${
          dragging
            ? 'border-emerald-500 bg-emerald-500/5 scale-[1.01]'
            : 'border-white/10 hover:border-white/20 hover:bg-white/[0.02]'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileInput}
        />
        <div className="flex flex-col items-center gap-3">
          <div className={`w-16 h-16 rounded-2xl flex items-center justify-center border transition-all ${
            dragging ? 'bg-emerald-500/20 border-emerald-500/40' : 'bg-white/5 border-white/10'
          }`}>
            <Upload className={`w-7 h-7 ${dragging ? 'text-emerald-400' : 'text-white/40'}`} />
          </div>
          <div>
            <p className="text-white font-semibold">Arrastra imágenes aquí</p>
            <p className="text-white/40 text-sm mt-1">o haz clic para seleccionar · Múltiples archivos permitidos</p>
          </div>
          <div className="flex flex-wrap justify-center gap-3 mt-2">
            {['Elimina metadatos EXIF', 'Ruido invisible ±2px', 'Cambia dimensiones', 'Hash 100% único'].map(tag => (
              <span key={tag} className="text-[10px] uppercase tracking-wider font-bold text-emerald-400/70 bg-emerald-500/5 border border-emerald-500/20 px-3 py-1 rounded-full">
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Actions bar */}
      {images.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-white/50">
            <span className="text-white font-bold">{doneCount}</span>/{images.length} procesadas
          </p>
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
              onClick={clearAll}
              className="flex items-center gap-2 bg-white/5 hover:bg-red-500/10 text-white/40 hover:text-red-400 border border-white/10 hover:border-red-500/20 px-4 py-2 rounded-xl text-sm transition"
            >
              <Trash2 className="w-4 h-4" />
              Limpiar
            </button>
          </div>
        </div>
      )}

      {/* Image Grid */}
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
              <div className="relative aspect-square bg-black/40 flex items-center justify-center overflow-hidden">
                {img.processedUrl ? (
                  <img src={img.processedUrl} alt={img.originalName} className="w-full h-full object-cover" />
                ) : img.status === 'processing' ? (
                  <div className="flex flex-col items-center gap-3 text-white/30">
                    <RefreshCcw className="w-8 h-8 animate-spin text-emerald-400" />
                    <span className="text-xs">Procesando…</span>
                  </div>
                ) : img.status === 'error' ? (
                  <div className="flex flex-col items-center gap-2 text-red-400/60">
                    <ZapOff className="w-8 h-8" />
                    <span className="text-xs">Error</span>
                  </div>
                ) : (
                  <ImageIcon className="w-12 h-12 text-white/10" />
                )}

                {img.status === 'done' && (
                  <div className="absolute top-2 right-2 bg-emerald-500 rounded-full p-1 shadow-lg">
                    <CheckCircle2 className="w-3.5 h-3.5 text-black" />
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="p-4 space-y-3">
                <p className="text-xs text-white/70 truncate font-medium">{img.originalName}</p>

                {img.status === 'done' && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-white/30">
                      <span>Original</span>
                      <span className="font-mono">{formatSize(img.originalSize)}</span>
                    </div>
                    <div className="flex justify-between text-[10px] text-emerald-400/80">
                      <span>Único</span>
                      <span className="font-mono">{formatSize(img.processedSize)}</span>
                    </div>
                    <div className="mt-2 space-y-1">
                      <div className="text-[10px] text-white/20 font-mono">{img.dimChange}</div>
                      <div className="text-[10px] text-white/20 font-mono">Ruido: ±{img.noiseLevel}px · EXIF: eliminado</div>
                    </div>
                  </div>
                )}

                <div className="flex gap-2">
                  {img.status === 'done' && img.processedUrl && (
                    <button
                      onClick={() => downloadDataUrl(img.processedUrl!, img.originalName.replace(/\.[^.]+$/, '_unique.jpg'))}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-black font-bold py-2 rounded-xl text-xs transition"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Descargar
                    </button>
                  )}
                  {(img.status === 'done' || img.status === 'error') && (
                    <button
                      onClick={() => reprocess(img.id)}
                      title="Regenerar con nuevo ruido"
                      className="p-2 bg-white/5 hover:bg-white/10 text-white/40 hover:text-emerald-400 rounded-xl border border-white/5 transition"
                    >
                      <Shuffle className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => remove(img.id)}
                    title="Eliminar"
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
        <div className="text-center py-6 text-white/20 text-sm">
          Sube imágenes para que cada una tenga un hash único e indetectable
        </div>
      )}
    </div>
  );
}
