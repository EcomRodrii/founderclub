import React, { useState, useRef, useEffect } from 'react';
import {
  Upload, Scissors, Info, RefreshCcw,
  CheckCircle2, AlertCircle, ScanText,
  Image as ImageIcon, Download, Copy,
  ArrowRight, Camera, Eye, X, BellOff,
  ChevronDown, ChevronUp, Shuffle, Package,
  Zap
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { injectRandomExif, cloneExifFrom } from '../lib/randomExif';

const authFetch = (url: string, body: any, timeoutMs = 95_000) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${localStorage.getItem("fc_token") || ""}`,
    },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(t));
};

interface DetectionResult {
  model: string;
  sku: string;
  reference: string;
  reference2: string;
  brandSerial: string;
  date: string;
  lvl: string;
  sizes: {
    us: string;
    uk: string;
    fr: string;
    jp: string;
  };
  modelName: string;
  color: string;
  listingTitle: string;
  listingDescription: string;
}

// ── Point 2: Film grain / homogenización de compresión ───────────────────
// Añade ruido de sensor uniforme al canvas antes del toDataURL(). Hace que
// los píxeles originales y los editados por IA compartan la misma firma
// estadística, resistiendo análisis forenses de bloques de compresión JPEG.
async function applyFilmGrain(canvas: HTMLCanvasElement, intensity = 14): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * intensity;
    d[i]   = Math.min(255, Math.max(0, d[i]   + n));          // R
    d[i+1] = Math.min(255, Math.max(0, d[i+1] + n * 0.97));  // G (ligera variación de canal)
    d[i+2] = Math.min(255, Math.max(0, d[i+2] + n * 0.95));  // B
  }
  ctx.putImageData(imageData, 0, 0);
}

// ── Point 3: Seriales correlacionados de fábrica ─────────────────────────
// Los labels generados el mismo día comparten el mismo prefijo de lote
// (derivado de la fecha con un LCG). Solo el contador de unidad es aleatorio.
// Esto hace que varias fotos del mismo "envío" sean intrínsecamente coherentes
// aunque sean imágenes distintas.

function _dayBatchCode(n: number): string {
  // LCG determinista por día — mismo resultado toda la jornada
  const t = new Date();
  let seed = t.getFullYear() * 10000 + (t.getMonth() + 1) * 100 + t.getDate();
  let result = '';
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
    result += Math.abs(seed) % 10;
  }
  return result;
}
function _rndD(n: number): string {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
}
function _rndA(n: number): string {
  const p = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return Array.from({ length: n }, () => p[Math.floor(Math.random() * p.length)]).join('');
}
function _rndAN(n: number): string {
  const p = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: n }, () => p[Math.floor(Math.random() * p.length)]).join('');
}

// NEW BALANCE: batch prefix (6) + unit (6) = 12; ref2: batch(4)+unit(3) = 7
function buildNBRef1(): string      { return _dayBatchCode(6) + _rndD(6); }
function buildNBRef2(): string      { return _dayBatchCode(4) + _rndD(3); }
function buildNBBrandCode(): string { return _rndA(4) + _rndD(4) + ' ' + _rndA(3); }

// ADIDAS: # + batch(4) + unit(5) = #XXXXXXXXX
function buildAdidasRef(): string         { return '#' + _dayBatchCode(4) + _rndD(5); }
function buildAdidasBrandSerial(): string { return _rndAN(7) + '<' + _rndD(5); }

// ASICS: 1 letra + 6 dígitos; serial 15 chars (6 letras + 9 dígitos)
function buildAsicsRef(): string         { return _rndA(1) + _rndD(6); }
function buildAsicsBrandSerial(): string { return _rndA(6) + _rndD(9); }

// ONITSUKA: F + batch(3) + unit(3) = F000000; serial 15 chars
function buildOnitsukaRef(): string { return 'F' + _dayBatchCode(3) + _rndD(3); }
function buildOnitsukaBrandSerial(): string {
  const regions = ['PI', 'AS', 'EU', 'US'];
  const region = regions[new Date().getDay() % regions.length];
  return (region + _rndAN(13)).slice(0, 15);
}

export default function TongueEditor() {
  const [activeBrand, setActiveBrand] = useState<'ADIDAS' | 'NEW BALANCE' | 'ASICS' | 'ONITSUKA'>('ADIDAS');
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detections, setDetections] = useState<DetectionResult | null>(null);
  const [customPromptAdidas, setCustomPromptAdidas] = useState<string>(`PROMPT ADIDAS - REGLAS DE ORO:
1. NUNCA cambies el SKU / MODELO (el código que aparece después de "ART NO" o "A:"). Debe ser EXACTAMENTE igual al original.
2. Modifica únicamente los dos últimos códigos de la parte inferior:
   - El código que empieza por # (9 dígitos): Cambia los 9 dígitos por aleatorios (solo números).
   - El código alfanumérico después de "adidas" (13 dígitos): Cámbialo manteniendo longitud y formato (mayúsculas/números).
3. Mantén tipografía, alineación, materiales y calidad originales. Everything else stays the same.`);

  const [customPromptNB, setCustomPromptNB] = useState<string>(`Modifica la etiqueta de esta zapatilla de New Balance. Cambia únicamente estos tres códigos:

* 213772792545
* 7173928
* LXCK1298 CLX

Reemplázalos por nuevos códigos aleatorios, pero manteniendo exactamente:
- La misma cantidad de caracteres
- El mismo formato (letras/números)
- El espacio entre caracteres exactamente igual

Específicamente:
- 213772792545 → otro número de 12 dígitos.
- 7173928 → otro número de 7 dígitos.
- LXCK1298 CLX → 4 letras, 4 números, espacio, 3 letras.

No cambies nada más (tipografía, texturas, iluminación y resto de datos deben ser idénticos).`);

  const [customPromptAsics, setCustomPromptAsics] = useState<string>(`PROMPT ASICS - REGLAS DE ORO:
1. NUNCA cambies el SKU (1204A191): Debe ser exacto para que el modelo sea reconocido como original.
2. Modifica los códigos de rastreo individuales:
   - Código F960925: Cambia la letra inicial y los 6 dígitos por otros aleatorios.
   - Número de Serie (N4VDCSSVG6CSMGH): Cámbialo por una combinación aleatoria de 15 caracteres (letras mayúsculas y números).
3. Mantén la estructura: Respeta las líneas verticales divisorias (|) en la tabla de tallas y la tipografía comprimida y limpia característica de Asics.`);

  const [customPromptOnitsuka, setCustomPromptOnitsuka] = useState<string>(`PROMPT ONITSUKA TIGER - PROTOCOLO DE PRECISIÓN:
1. Integridad del SKU (Modelo):
PROHIBIDO alterar el código THL7C2. Debe aparecer en la parte superior, centrado y con un ligero espaciado entre caracteres.

2. Bloque de Tallas (Matriz de Datos):
Mantener exactamente la cuadrícula de 2x3 celdas separadas por líneas verticales finas (|).
Valores Obligatorios: CM 24.0, EURO 38, US 5½, UK 4.5, BR 36, CN 240(2.5). No redondear ni cambiar formatos (ej. mantener el "½" en formato pequeño).

3. Reglas de Variación Inferior (Identidad Única):
Código de Lote: Debe empezar por F seguido de exactamente 6 dígitos aleatorios (ej. F602841).
Identificador de Región: Mantener las siglas PI a la derecha del código de lote.
Serial de Unidad: Generar un código alfanumérico de 15 caracteres en mayúsculas. Regla estricta: Debe ser diferente para la zapatilla izquierda y la derecha para simular un par auténtico.

4. Especificaciones Técnicas de Diseño:
Tipografía: Usar una fuente Sans-Serif ultra-condensada (tipo Helvetica Compressed o similar), con impresión de transferencia térmica (puntos de tinta ligeramente visibles bajo aumento).
Ausencia de Branding: No incluir el logo del tigre ni la palabra "Onitsuka". La etiqueta debe ser estrictamente informativa.
Soporte: Fondo blanco mate con textura de tejido sintético, bordes termosellados y costura perimetral que la une a la lengüeta.
Idioma: "MADE IN INDONESIA" seguido de "FABRIQUE EN INDONESIE" justo debajo.`);
  
  const [showDownloadWarning, setShowDownloadWarning] = useState(false);
  const [neverWarn, setNeverWarn] = useState(() => localStorage.getItem('tongue_no_warn') === '1');
  // Point 4: foto real cuyo EXIF se clona en la descarga
  const [exifSourceUrl, setExifSourceUrl] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const exifInputRef = useRef<HTMLInputElement>(null);

  // ── Box label state ──────────────────────────────────────────────────────
  const [boxOriginalImage, setBoxOriginalImage] = useState<string | null>(null);
  const [boxImage, setBoxImage] = useState<string | null>(null);
  const [loadingBox, setLoadingBox] = useState(false);
  const boxFileInputRef = useRef<HTMLInputElement>(null);

  // ── UI state ─────────────────────────────────────────────────────────────
  const [showAllData, setShowAllData] = useState(false);

  // Load admin-defined prompts from server on mount
  useEffect(() => {
    fetch('/api/tongue/prompts')
      .then(r => r.ok ? r.json() : [])
      .then((rows: { brand: string; prompt: string }[]) => {
        rows.forEach(({ brand, prompt }) => {
          if (!prompt) return;
          if (brand === 'ADIDAS') setCustomPromptAdidas(prompt);
          else if (brand === 'NEW BALANCE') setCustomPromptNB(prompt);
          else if (brand === 'ASICS') setCustomPromptAsics(prompt);
          else if (brand === 'ONITSUKA') setCustomPromptOnitsuka(prompt);
        });
      })
      .catch(() => {}); // silently ignore if offline
  }, []);

  const compressImage = (dataUrl: string, maxPx = 1280, quality = 0.85): Promise<string> =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        // Guard: si las dimensiones son 0 (imagen corrupta o formato no soportado),
        // devolver el dataUrl original sin procesar para no producir un JPEG negro.
        if (!img.width || !img.height) { resolve(dataUrl); return; }
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        try {
          canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch {
          resolve(dataUrl); // canvas tainted u otro error → devolver original
        }
      };
      img.onerror = () => resolve(dataUrl); // fallback: usar imagen original sin comprimir
      img.src = dataUrl;
    });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset para nueva foto
    setDetections(null);
    setGeneratedImage(null);
    setError(null);

    const reader = new FileReader();
    reader.onloadend = async () => {
      const raw = reader.result as string;
      // Mostrar imagen inmediatamente (sin esperar compresión) para que el
      // usuario nunca vea negro — la UI responde al instante.
      setOriginalImage(raw);
      // Comprimir en background y reemplazar (reduce payload a Gemini)
      const compressed = await compressImage(raw);
      setOriginalImage(compressed);
      runOCR(compressed);
    };
    reader.readAsDataURL(file);
  };

  const runOCR = async (base64Image: string) => {
    setLoading(true);
    setError(null);
    setDetections(null);
    setStatus('Leyendo lengüeta...');
    try {
      const res = await authFetch('/api/tongue/analyze', { imageBase64: base64Image, brand: activeBrand });
      const data = await res.json();
      if (!res.ok) {
        // Error claro según código HTTP
        if (res.status === 429) throw new Error('Demasiadas peticiones. Espera un momento e inténtalo de nuevo.');
        if (res.status === 503) throw new Error('Servicio no disponible. Inténtalo en unos segundos.');
        throw new Error(data.error || `Error del servidor (${res.status})`);
      }
      setDetections(data);
      setStatus('✓ Datos extraídos');
    } catch (err: any) {
      const msg = err.message || String(err);
      if (err.name === 'AbortError' || msg.includes('aborted')) {
        setError('Tiempo de espera agotado (>90s). Inténtalo de nuevo.');
      } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed')) {
        setError('Sin conexión. Comprueba tu internet e inténtalo de nuevo.');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const generateRandomReference = () => {
    if (!detections) return;
    if (activeBrand === 'NEW BALANCE') {
      setDetections({ ...detections, reference: buildNBRef1() });
    } else if (activeBrand === 'ONITSUKA') {
      setDetections({ ...detections, reference: buildOnitsukaRef() });
    } else if (activeBrand === 'ASICS') {
      setDetections({ ...detections, reference: buildAsicsRef() });
    } else {
      setDetections({ ...detections, reference: buildAdidasRef() });
    }
  };

  const generateRandomReference2 = () => {
    if (!detections) return;
    setDetections({ ...detections, reference2: buildNBRef2() });
  };

  const generateRandomBrandSerial = () => {
    if (!detections) return;
    if (activeBrand === 'NEW BALANCE') {
      setDetections({ ...detections, brandSerial: buildNBBrandCode() });
    } else if (activeBrand === 'ONITSUKA') {
      setDetections({ ...detections, brandSerial: buildOnitsukaBrandSerial() });
    } else if (activeBrand === 'ASICS') {
      setDetections({ ...detections, brandSerial: buildAsicsBrandSerial() });
    } else {
      setDetections({ ...detections, brandSerial: buildAdidasBrandSerial() });
    }
  };

  const handleRandomizeAll = () => {
    if (!detections) return;
    const n = { ...detections };
    if (activeBrand === 'NEW BALANCE') {
      n.reference = buildNBRef1(); n.reference2 = buildNBRef2(); n.brandSerial = buildNBBrandCode();
    } else if (activeBrand === 'ONITSUKA') {
      n.reference = buildOnitsukaRef(); n.brandSerial = buildOnitsukaBrandSerial();
    } else if (activeBrand === 'ASICS') {
      n.reference = buildAsicsRef(); n.brandSerial = buildAsicsBrandSerial();
    } else {
      n.reference = buildAdidasRef(); n.brandSerial = buildAdidasBrandSerial();
    }
    setDetections(n);
  };

  const executeDownload = async () => {
    if (!generatedImage) return;
    try {
      setStatus("Preparando descarga...");
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("Error al cargar la imagen."));
        img.src = generatedImage;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error("No se pudo obtener el contexto del canvas.");
      ctx.drawImage(img, 0, 0);
      // Point 2: homogenización — ruido de sensor uniforme antes de recodificar
      await applyFilmGrain(canvas);
      // Calidad 0.87 = foto de móvil típica (0.95 parece procesada por app)
      const rawDataUrl = canvas.toDataURL('image/jpeg', 0.87);
      // Point 4: clonar EXIF de foto real si el usuario la aportó,
      // si no inyectar metadatos de cámara aleatorios (elimina metadata AI).
      const dataUrl = exifSourceUrl
        ? await cloneExifFrom(exifSourceUrl, rawDataUrl)
        : await injectRandomExif(rawDataUrl);
      const link = document.createElement('a');
      const ts = Math.floor(Date.now() / 1000);
      const brandSlug = activeBrand.replace(/\s+/g, '_');
      link.href = dataUrl;
      link.download = `IMG_${brandSlug}_RECON_${ts}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setStatus("Imagen descargada con éxito.");
    } catch (err) {
      console.error("Download fail:", err);
      setError("Fallo al descargar. Intenta copiar la imagen.");
    }
  };

  const handleDownload = () => {
    if (neverWarn) { executeDownload(); return; }
    setShowDownloadWarning(true);
  };

  const generateModifiedTongue = async () => {
    if (!detections) return;
    setLoading(true);
    setError(null);
    setStatus('Generando lengüeta...');
    try {
      const res = await authFetch('/api/tongue/generate', {
        imageBase64: originalImage,
        brand: activeBrand,
        detections,
        customPrompt: activeBrand === 'ADIDAS' ? customPromptAdidas : activeBrand === 'ASICS' ? customPromptAsics : activeBrand === 'ONITSUKA' ? customPromptOnitsuka : customPromptNB,
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 429) throw new Error('Demasiadas peticiones. Espera unos segundos.');
        if (res.status === 422) throw new Error(data.error || 'Gemini no generó imagen. Inténtalo de nuevo.');
        throw new Error(data.error || `Error (${res.status}). Inténtalo de nuevo.`);
      }
      if (data.image) {
        setGeneratedImage(data.image);
        setStatus('✓ Lengüeta generada');
      } else {
        throw new Error('Sin imagen en la respuesta. Inténtalo de nuevo.');
      }
    } catch (err: any) {
      const msg = err.message || String(err);
      if (err.name === 'AbortError' || msg.includes('aborted')) {
        setError('Tiempo de espera agotado. Inténtalo de nuevo.');
      } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed')) {
        setError('Sin conexión. Comprueba tu internet.');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const generateBoxLabel = async () => {
    if (!detections) return;
    setLoadingBox(true);
    setBoxImage(null);
    setError(null);
    try {
      const res = await authFetch('/api/box/generate', {
        imageBase64: boxOriginalImage,
        brand: activeBrand,
        detections,
        customPrompt: '',
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 429) throw new Error('Demasiadas peticiones. Espera unos segundos.');
        throw new Error(data.error || `Error (${res.status}). Inténtalo de nuevo.`);
      }
      if (data.image) {
        setBoxImage(data.image);
      } else {
        throw new Error('Sin imagen en la respuesta. Inténtalo de nuevo.');
      }
    } catch (err: any) {
      const msg = err.message || String(err);
      if (err.name === 'AbortError' || msg.includes('aborted')) {
        setError('Tiempo de espera agotado. Inténtalo de nuevo.');
      } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed')) {
        setError('Sin conexión. Comprueba tu internet.');
      } else {
        setError(msg);
      }
    } finally {
      setLoadingBox(false);
    }
  };

  const handleDownloadBox = async () => {
    if (!boxImage) return;
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = boxImage; });
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      await applyFilmGrain(canvas);
      const rawUrl = canvas.toDataURL('image/jpeg', 0.87);
      const finalUrl = exifSourceUrl
        ? await cloneExifFrom(exifSourceUrl, rawUrl)
        : await injectRandomExif(rawUrl);
      const link = document.createElement('a');
      const ts = Math.floor(Date.now() / 1000);
      const brandSlug = activeBrand.replace(/\s+/g, '_');
      link.href = finalUrl;
      link.download = `IMG_${brandSlug}_BOX_${ts}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      setError('Error al descargar etiqueta de caja.');
    }
  };

  // hidden file inputs (shared across sections)
  const fileInputs = (
    <>
      <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFileUpload} />
      <input type="file" ref={cameraInputRef} className="hidden" accept="image/*" capture="environment" onChange={handleFileUpload} />
      <input type="file" ref={exifInputRef} className="hidden" accept="image/jpeg,image/jpg"
        onChange={(e) => {
          const file = e.target.files?.[0]; if (!file) return;
          const reader = new FileReader();
          reader.onloadend = () => setExifSourceUrl(reader.result as string);
          reader.readAsDataURL(file);
        }}
      />
      <input type="file" ref={boxFileInputRef} className="hidden" accept="image/*"
        onChange={(e) => {
          const file = e.target.files?.[0]; if (!file) return;
          const reader = new FileReader();
          reader.onloadend = async () => { const c = await compressImage(reader.result as string); setBoxOriginalImage(c); };
          reader.readAsDataURL(file);
        }}
      />
    </>
  );

  return (
    <div className="space-y-4 max-w-xl mx-auto">
      {fileInputs}

      {/* ── Aviso descarga ───────────────────────────────────────────────── */}
      <AnimatePresence>
        {showDownloadWarning && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
              onClick={() => setShowDownloadWarning(false)} />
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 8 }}
              transition={{ type: 'spring', damping: 28, stiffness: 340 }}
              className="fixed inset-x-4 bottom-6 sm:inset-auto sm:left-1/2 sm:-translate-x-1/2 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 z-50 w-auto sm:w-full sm:max-w-md"
            >
              <div className="bg-[#141414] border border-[#d4ff00]/25 rounded-[24px] p-6 shadow-[0_32px_80px_rgba(0,0,0,0.7)]">
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-[#d4ff00]/10 border border-[#d4ff00]/20 flex items-center justify-center shrink-0">
                      <Eye className="w-5 h-5 text-[#d4ff00]" />
                    </div>
                    <h3 className="text-[#f2f2ef] font-bold text-base leading-tight">
                      Ojo chaval,<br /><span className="text-[#d4ff00]">revisa antes de subir</span>
                    </h3>
                  </div>
                  <button onClick={() => setShowDownloadWarning(false)} className="text-[#555550] hover:text-[#f2f2ef] transition-colors shrink-0 mt-0.5">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <p className="text-[#888880] text-sm leading-relaxed mb-5">
                  Antes de subir a Vinted,{' '}
                  <span className="text-[#f2f2ef] font-medium">comprueba que la lengüeta esté perfecta</span>
                  {' '}— códigos legibles, fondo limpio, sin artefactos raros.
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <button onClick={() => { setShowDownloadWarning(false); executeDownload(); }}
                    className="flex-1 bg-[#d4ff00] hover:bg-[#b3da00] text-black font-bold py-2.5 px-4 rounded-xl text-sm transition flex items-center justify-center gap-2">
                    <Download className="w-4 h-4" /> Entendido, descargar
                  </button>
                  <button onClick={() => setShowDownloadWarning(false)}
                    className="flex-1 bg-white/[0.06] hover:bg-white/[0.1] text-[#888880] hover:text-[#f2f2ef] font-medium py-2.5 px-4 rounded-xl text-sm transition">
                    Revisar primero
                  </button>
                </div>
                <button onClick={() => { localStorage.setItem('tongue_no_warn', '1'); setNeverWarn(true); setShowDownloadWarning(false); executeDownload(); }}
                  className="w-full mt-3 flex items-center justify-center gap-1.5 text-[#444440] hover:text-[#666660] text-xs transition py-1">
                  <BellOff className="w-3 h-3" /> No volver a mostrar este aviso
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ── MARCA ────────────────────────────────────────────────────────── */}
      <div className="flex gap-2">
        {([
          { key: 'ADIDAS', label: 'Adidas' },
          { key: 'NEW BALANCE', label: 'NB' },
          { key: 'ASICS', label: 'Asics' },
          { key: 'ONITSUKA', label: 'Onitsuka' },
        ] as { key: 'ADIDAS' | 'NEW BALANCE' | 'ASICS' | 'ONITSUKA'; label: string }[]).map(({ key, label }) => (
          <button key={key} onClick={() => setActiveBrand(key)}
            className={`flex-1 py-2.5 rounded-2xl border-2 transition-all font-bold tracking-wide text-xs ${
              activeBrand === key
                ? 'bg-acid border-acid text-black shadow-acid'
                : 'bg-white/5 border-white/10 text-white/40 hover:bg-white/10 hover:border-white/20'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── PASO 1: SUBIR FOTOS ──────────────────────────────────────────── */}
      <div className="bg-[#141414] border border-white/5 rounded-3xl p-5 space-y-4">
        <div className="flex items-center gap-2.5">
          <span className="w-5 h-5 rounded-full bg-acid text-black text-[9px] font-black flex items-center justify-center shrink-0">1</span>
          <h3 className="text-xs font-bold text-white/50 uppercase tracking-widest">Subir fotos</h3>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* Lengüeta */}
          <div>
            <p className="text-[9px] uppercase text-white/30 mb-2 tracking-wider">Lengüeta</p>
            {originalImage ? (
              <div className="relative h-32 rounded-2xl overflow-hidden border border-acid/40 bg-black">
                <img src={originalImage} className="w-full h-full object-contain" />
                <button onClick={() => fileInputRef.current?.click()}
                  className="absolute bottom-2 right-2 bg-black/70 border border-white/10 text-white/60 p-1.5 rounded-lg hover:bg-black transition">
                  <RefreshCcw className="w-3 h-3" />
                </button>
                {loading && !detections && (
                  <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2">
                    <div className="flex items-center gap-2 bg-black/60 rounded-xl px-3 py-2">
                      <RefreshCcw className="w-3.5 h-3.5 text-acid animate-spin" />
                      <span className="text-[10px] text-acid font-bold uppercase tracking-widest">Analizando...</span>
                    </div>
                  </div>
                )}
                {detections && (
                  <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-acid flex items-center justify-center">
                    <CheckCircle2 className="w-3 h-3 text-black" />
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <button onClick={() => cameraInputRef.current?.click()}
                  className="h-32 flex flex-col items-center justify-center gap-2 bg-acid-soft hover:bg-acid/20 border-2 border-dashed border-acid/40 rounded-2xl transition">
                  <Camera className="w-6 h-6 text-acid" />
                  <span className="text-[10px] font-bold text-acid">Cámara</span>
                </button>
                <button onClick={() => fileInputRef.current?.click()}
                  className="py-2 flex items-center justify-center gap-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition text-[10px] text-white/40">
                  <Upload className="w-3 h-3" /> Galería
                </button>
              </div>
            )}
          </div>

          {/* Caja */}
          <div>
            <p className="text-[9px] uppercase text-white/30 mb-2 tracking-wider">Caja <span className="text-white/15 normal-case font-normal">(opcional)</span></p>
            {boxOriginalImage ? (
              <div className="relative h-32 rounded-2xl overflow-hidden border border-white/15 bg-black">
                <img src={boxOriginalImage} className="w-full h-full object-contain opacity-75" />
                <button onClick={() => boxFileInputRef.current?.click()}
                  className="absolute bottom-2 right-2 bg-black/70 border border-white/10 text-white/60 p-1.5 rounded-lg hover:bg-black transition">
                  <RefreshCcw className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <button onClick={() => boxFileInputRef.current?.click()}
                className="w-full h-[9.5rem] flex flex-col items-center justify-center gap-2 bg-white/3 hover:bg-white/6 border-2 border-dashed border-white/10 hover:border-white/20 rounded-2xl transition">
                <Package className="w-6 h-6 text-white/20" />
                <span className="text-[10px] text-white/25">Subir foto caja</span>
              </button>
            )}
          </div>
        </div>

        {/* EXIF opcional */}
        <div className="flex items-center gap-2 pt-1">
          <button onClick={() => exifInputRef.current?.click()}
            className={`flex items-center gap-1.5 text-[10px] px-3 py-1.5 rounded-lg border transition-all ${
              exifSourceUrl
                ? 'border-acid/50 text-acid bg-acid-soft'
                : 'border-white/8 text-white/20 hover:text-white/40 hover:border-white/15'
            }`}>
            <Camera className="w-3 h-3" />
            {exifSourceUrl ? 'EXIF real activo ✓' : 'Clonar EXIF de foto real'}
          </button>
          {exifSourceUrl && (
            <button onClick={() => setExifSourceUrl(null)} className="text-white/20 hover:text-red-400 transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-3 py-3 px-4 bg-red-500/10 border border-red-500/20 rounded-2xl">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-red-400 leading-relaxed">{error}</p>
              {originalImage && (
                <button
                  onClick={() => runOCR(originalImage)}
                  className="mt-2 text-[10px] text-red-300 hover:text-white border border-red-500/30 hover:border-red-400/50 rounded-lg px-2.5 py-1 transition flex items-center gap-1.5"
                >
                  <RefreshCcw className="w-3 h-3" /> Reintentar análisis
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── PASO 2: CÓDIGOS ──────────────────────────────────────────────── */}
      <AnimatePresence>
        {detections && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            className="bg-[#141414] border border-white/5 rounded-3xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="w-5 h-5 rounded-full bg-acid text-black text-[9px] font-black flex items-center justify-center shrink-0">2</span>
                <h3 className="text-xs font-bold text-white/50 uppercase tracking-widest">Códigos a cambiar</h3>
              </div>
              <button onClick={handleRandomizeAll}
                className="flex items-center gap-1.5 text-[10px] font-bold text-black bg-acid hover:bg-acid/80 rounded-xl px-3 py-2 transition">
                <Shuffle className="w-3 h-3" /> Aleatorizar
              </button>
            </div>

            {/* Campos clave */}
            <div className="space-y-3">
              <div className="flex gap-3 items-end">
                <div className="flex-1 space-y-1">
                  <label className="text-[9px] uppercase text-white/30 tracking-wider">
                    {activeBrand === 'ADIDAS' ? 'Referencia #' : activeBrand === 'ONITSUKA' ? 'Código de Lote' : 'Referencia 1'}
                  </label>
                  <input value={detections.reference}
                    onChange={e => setDetections({ ...detections, reference: e.target.value })}
                    className="w-full bg-black/50 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white focus:border-acid outline-none font-mono" />
                </div>
                <button onClick={generateRandomReference}
                  className="mb-0.5 p-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition">
                  <Shuffle className="w-3.5 h-3.5 text-white/40" />
                </button>
              </div>

              {activeBrand === 'NEW BALANCE' && (
                <div className="flex gap-3 items-end">
                  <div className="flex-1 space-y-1">
                    <label className="text-[9px] uppercase text-white/30 tracking-wider">Referencia 2</label>
                    <input value={detections.reference2 || ''}
                      onChange={e => setDetections({ ...detections, reference2: e.target.value })}
                      className="w-full bg-black/50 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white focus:border-acid outline-none font-mono" />
                  </div>
                  <button onClick={generateRandomReference2}
                    className="mb-0.5 p-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition">
                    <Shuffle className="w-3.5 h-3.5 text-white/40" />
                  </button>
                </div>
              )}

              <div className="flex gap-3 items-end">
                <div className="flex-1 space-y-1">
                  <label className="text-[9px] uppercase text-white/30 tracking-wider">Serial / Cód. Marca</label>
                  <input value={detections.brandSerial}
                    onChange={e => setDetections({ ...detections, brandSerial: e.target.value })}
                    className="w-full bg-black/50 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white focus:border-acid outline-none font-mono" />
                </div>
                <button onClick={generateRandomBrandSerial}
                  className="mb-0.5 p-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition">
                  <Shuffle className="w-3.5 h-3.5 text-white/40" />
                </button>
              </div>
            </div>

            {/* Acordeón: datos secundarios */}
            <button onClick={() => setShowAllData(v => !v)}
              className="w-full flex items-center justify-between text-[10px] text-white/25 hover:text-white/45 transition pt-1">
              <span>Modelo, SKU, tallas, fecha...</span>
              {showAllData ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>

            <AnimatePresence>
              {showAllData && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                  <div className="grid grid-cols-2 gap-3 pt-3 border-t border-white/5">
                    {[
                      { label: 'Modelo', key: 'model' as const },
                      { label: 'SKU / Art No', key: 'sku' as const },
                      { label: 'Fecha', key: 'date' as const },
                      { label: 'LVL / Factory', key: 'lvl' as const },
                    ].map(({ label, key }) => (
                      <div key={key} className="space-y-1">
                        <label className="text-[9px] uppercase text-white/25">{label}</label>
                        <input value={(detections as any)[key] || ''}
                          onChange={e => setDetections({ ...detections, [key]: e.target.value })}
                          className="w-full bg-black/40 border border-white/8 rounded-lg px-3 py-2 text-xs text-white focus:border-acid outline-none" />
                      </div>
                    ))}
                    <div className="col-span-2 grid grid-cols-4 gap-2">
                      {(['us', 'uk', 'fr', 'jp'] as const).map(size => (
                        <div key={size} className="space-y-1">
                          <label className="text-[9px] uppercase text-white/25">{size}</label>
                          <input value={detections.sizes[size]}
                            onChange={e => setDetections({ ...detections, sizes: { ...detections.sizes, [size]: e.target.value } })}
                            className="w-full bg-black/40 border border-white/8 rounded-lg px-2 py-2 text-center text-xs text-white focus:border-acid outline-none uppercase" />
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── PASO 3: GENERAR ──────────────────────────────────────────────── */}
      <AnimatePresence>
        {detections && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
            <div className="flex items-center gap-2.5">
              <span className="w-5 h-5 rounded-full bg-acid text-black text-[9px] font-black flex items-center justify-center shrink-0">3</span>
              <h3 className="text-xs font-bold text-white/50 uppercase tracking-widest">Generar</h3>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button onClick={generateModifiedTongue} disabled={loading}
                className="py-5 bg-acid hover:bg-acid/90 text-black font-black rounded-2xl flex flex-col items-center gap-2 transition disabled:opacity-50">
                {loading
                  ? <RefreshCcw className="w-5 h-5 animate-spin" />
                  : <Scissors className="w-5 h-5" />}
                <span className="text-xs tracking-wider">LENGÜETA</span>
              </button>

              <button onClick={generateBoxLabel} disabled={loadingBox || !detections}
                className="py-5 bg-white/8 hover:bg-white/12 text-white font-black rounded-2xl flex flex-col items-center gap-2 border border-white/10 hover:border-white/20 transition disabled:opacity-40">
                {loadingBox
                  ? <RefreshCcw className="w-5 h-5 animate-spin" />
                  : <Package className="w-5 h-5 text-white/60" />}
                <span className="text-xs tracking-wider text-white/70">CAJA</span>
              </button>
            </div>

            {!boxOriginalImage && (
              <p className="text-[9px] text-white/20 text-center">
                Para la caja, sube la foto en el paso 1
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── RESULTADOS ───────────────────────────────────────────────────── */}
      <AnimatePresence>
        {(generatedImage || boxImage || (loading && detections) || loadingBox) && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            className={`grid gap-4 ${(generatedImage || loading) && (boxImage || loadingBox) ? 'grid-cols-2' : 'grid-cols-1'}`}>

            {/* Lengüeta resultado */}
            {(generatedImage || (loading && detections)) && (
              <div className="bg-[#141414] border border-white/5 rounded-3xl p-4 flex flex-col items-center gap-3 relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-transparent via-acid to-transparent" />
                <p className="text-[9px] uppercase text-white/30 tracking-widest self-start">Lengüeta</p>
                {generatedImage ? (
                  <>
                    <img src={generatedImage} className="max-w-full rounded-xl border border-white/10 shadow-lg" alt="Lengüeta generada" />
                    <div className="flex gap-2 w-full">
                      <button onClick={handleDownload}
                        className="flex-1 py-2.5 bg-acid text-black font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 hover:bg-acid/90 transition">
                        <Download className="w-3.5 h-3.5" /> Descargar
                      </button>
                      <button onClick={generateModifiedTongue} disabled={loading}
                        className="p-2.5 bg-white/8 hover:bg-white/12 border border-white/10 text-white/40 hover:text-white rounded-xl transition disabled:opacity-30"
                        title="Regenerar">
                        <RefreshCcw className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => {
                        fetch(generatedImage).then(r => r.blob()).then(blob => {
                          navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
                        });
                      }}
                        className="p-2.5 bg-white/8 hover:bg-white/12 border border-white/10 text-white/50 rounded-xl transition">
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="h-32 flex flex-col items-center justify-center gap-2 w-full">
                    <RefreshCcw className="w-6 h-6 text-acid animate-spin" />
                    <span className="text-[10px] text-white/40 uppercase tracking-widest">{status || 'Generando...'}</span>
                  </div>
                )}
              </div>
            )}

            {/* Caja resultado */}
            {(boxImage || loadingBox) && (
              <div className="bg-[#141414] border border-white/5 rounded-3xl p-4 flex flex-col items-center gap-3 relative overflow-hidden">
                <p className="text-[9px] uppercase text-white/30 tracking-widest self-start">Caja</p>
                {boxImage ? (
                  <>
                    <img src={boxImage} className="max-w-full rounded-xl border border-white/10 shadow-lg" alt="Etiqueta caja" />
                    <div className="flex gap-2 w-full">
                      <button onClick={handleDownloadBox}
                        className="flex-1 py-2.5 bg-white text-black font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 hover:bg-acid transition">
                        <Download className="w-3.5 h-3.5" /> Descargar
                      </button>
                      <button onClick={generateBoxLabel} disabled={loadingBox}
                        className="p-2.5 bg-white/8 hover:bg-white/12 border border-white/10 text-white/40 hover:text-white rounded-xl transition disabled:opacity-30"
                        title="Regenerar">
                        <RefreshCcw className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="h-32 flex flex-col items-center justify-center gap-2 w-full">
                    <RefreshCcw className="w-6 h-6 text-white/40 animate-spin" />
                    <span className="text-[10px] text-white/30 uppercase tracking-widest">Generando caja...</span>
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── TEXTO VINTED ─────────────────────────────────────────────────── */}
      <AnimatePresence>
        {detections?.listingTitle && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            className="bg-[#141414] border border-white/5 rounded-3xl p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-acid" />
              <h3 className="text-xs font-bold text-white/50 uppercase tracking-widest">Texto para Vinted</h3>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[9px] uppercase text-acid/80 tracking-wider">Título</label>
                <button onClick={() => { navigator.clipboard.writeText(detections.listingTitle); setStatus("Título copiado"); }}
                  className="flex items-center gap-1 text-[9px] text-white/30 hover:text-white transition">
                  <Copy className="w-2.5 h-2.5" /> Copiar
                </button>
              </div>
              <input value={detections.listingTitle || ''}
                onChange={e => setDetections({ ...detections, listingTitle: e.target.value })}
                className="w-full bg-acid-soft border border-acid/30 rounded-xl px-3 py-2.5 text-xs text-white focus:border-acid outline-none" />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[9px] uppercase text-acid/80 tracking-wider">Descripción</label>
                <button onClick={() => { navigator.clipboard.writeText(detections.listingDescription); setStatus("Descripción copiada"); }}
                  className="flex items-center gap-1 text-[9px] text-white/30 hover:text-white transition">
                  <Copy className="w-2.5 h-2.5" /> Copiar
                </button>
              </div>
              <textarea value={detections.listingDescription || ''}
                onChange={e => setDetections({ ...detections, listingDescription: e.target.value })}
                className="w-full bg-acid-soft border border-acid/30 rounded-xl px-3 py-2.5 text-xs text-white focus:border-acid outline-none h-24 resize-none" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
