import React, { useState, useRef } from 'react';
import { 
  Upload, Scissors, Info, RefreshCcw, 
  CheckCircle2, AlertCircle, ScanText, 
  Image as ImageIcon, Download, Copy,
  ArrowRight
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI } from "@google/genai";

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

export default function TongueEditor() {
  const [activeBrand, setActiveBrand] = useState<'ADIDAS' | 'NEW BALANCE'>('ADIDAS');
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
   - El código alfanumérico después de “adidas” (13 dígitos): Cámbialo manteniendo longitud y formato (mayúsculas/números).
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
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      setOriginalImage(reader.result as string);
      runOCR(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const runOCR = async (base64Image: string) => {
    setLoading(true);
    setStatus('Analizando lengüeta con OCR...');
    setError(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
      const prompt = `Analiza esta imagen de una lengüeta de zapatilla ${activeBrand}. 
      
      1. Extrae los datos técnicos:
      - model (ID de modelo, ej: JQ5874 o MR530SG)
      - sku (lo mismo que model)
      - reference (referencia de 12 dígitos en NB, o serie en Adidas ej: #123456789)
      - reference2 (7 dígitos en NB)
      - brandSerial (ej: LXCK1298 CLX o FGwKZ39<82143)
      - date (ej: 05/22)
      - lvl (ej: EVN 791001)
      - sizes (un objeto con us, uk, fr, jp)

      2. BÚSQUEDA EN INTERNET: Utiliza Google Search para encontrar el nombre comercial exacto (ej: "Adidas Samba Leopard") usando la marca y el código del modelo detectado.

      3. Genera el JSON con estos campos adicionales:
      - modelName: Nombre comercial real (ej: Adidas Samba Leopard)
      - color: Color dominante en francés (ej: blanc et vert)
      - listingTitle: Título para Vinted EXACTAMENTE así: "[modelName] - Pointure [FR] [color] / [model]"
      - listingDescription: Descripción en francés EXACTAMENTE con este formato: "[Frase aleatoria natural como 'Ma sœur me les a offertes, mais ce n’est finalmente pas mon style, donc je préfère les vendre' o similar]\n\nCouleur : [color]\nModèle : [model]\nTaille : [fr]"

      Si no encuentras algún dato, pon "Desconocido". Solo devuelve el JSON puro.`;

      const imagePart = {
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Image.split(',')[1],
        },
      };

      const result = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: { parts: [imagePart, { text: prompt }] },
        tools: [{ googleSearch: {} }]
      });

      const text = result.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        setDetections(data);
        setStatus('Datos extraídos correctamente.');
      } else {
        setError('No se pudo procesar la respuesta del OCR.');
      }
    } catch (err: any) {
      console.error('OCR Error:', err);
      const msg = err.message || String(err);
      if (msg.includes('401') || msg.toLowerCase().includes('permission denied')) {
        setError('Error de sesión (401) o permisos en OCR. Por favor, refresca la página.');
      } else if (msg.toLowerCase().includes('quota') || msg.includes('429')) {
        setError('Límite de uso alcanzado (Quota Exceeded) en el escáner. Por favor, espera un momento.');
      } else {
        setError('Error en el análisis OCR: ' + msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const generateRandomReference = () => {
    if (!detections) return;
    if (activeBrand === 'NEW BALANCE') {
      let res = '';
      for (let i = 0; i < 12; i++) res += Math.floor(Math.random() * 10);
      setDetections({ ...detections, reference: res });
    } else {
      const randomNum = Math.floor(100000000 + Math.random() * 900000000);
      setDetections({ ...detections, reference: `#${randomNum}` });
    }
  };

  const generateRandomReference2 = () => {
    if (!detections) return;
    let res = '';
    for (let i = 0; i < 7; i++) res += Math.floor(Math.random() * 10);
    setDetections({ ...detections, reference2: res });
  };

  const generateRandomBrandSerial = () => {
    if (!detections) return;
    if (activeBrand === 'NEW BALANCE') {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const nums = '0123456789';
      let p1 = ''; for(let i=0; i<4; i++) p1 += chars.charAt(Math.floor(Math.random()*chars.length));
      let p2 = ''; for(let i=0; i<4; i++) p2 += nums.charAt(Math.floor(Math.random()*nums.length));
      let p3 = ''; for(let i=0; i<3; i++) p3 += chars.charAt(Math.floor(Math.random()*chars.length));
      setDetections({ ...detections, brandSerial: `${p1}${p2} ${p3}` });
    } else {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let result = '';
      for (let i = 0; i < 7; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      result += '<';
      for (let i = 0; i < 5; i++) {
        result += Math.floor(Math.random() * 10);
      }
      setDetections({ ...detections, brandSerial: result });
    }
  };

  const handleDownload = async () => {
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
      
      // We convert to a high-quality JPEG to strip all AI metadata and ensure a clean, raw-looking file
      const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
      
      const link = document.createElement('a');
      const ts = Math.floor(Date.now() / 1000);
      link.href = dataUrl;
      link.download = `IMG_NB_RECON_${ts}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      setStatus("Imagen descargada con éxito.");
    } catch (err) {
      console.error("Download fail:", err);
      setError("Fallo al descargar. Intenta copiar la imagen.");
    }
  };

  const generateModifiedTongue = async () => {
    if (!detections) return;
    setLoading(true);
    setStatus('Generando nueva imagen de lengüeta...');

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
      
      // Construct the final prompt using the detection data to prevent hallucinations
      let brandPrompt = '';
      const dataStr = `
        USE THESE EXACT VALUES:
        - MODEL/SKU: ${detections.sku}
        - DATE: ${detections.date}
        - FACTORY/LVL: ${detections.lvl}
        - REFERENCE: ${detections.reference}
        - REFERENCE_2: ${detections.reference2 || ''}
        - BRAND_SERIAL: ${detections.brandSerial}
        - SIZES: US ${detections.sizes.us}, UK ${detections.sizes.uk}, FR ${detections.sizes.fr}, JP ${detections.sizes.jp}
      `;

      if (activeBrand === 'ADIDAS') {
        brandPrompt = `
### CRITICAL IDENTITY RECONSTRUCTION - ADIDAS
Precision printing engine task. Recreate the label with 100% adherence to fixed data.

STRICTLY DO NOT CHANGE (FORBIDDEN):
- ART NO / SKU: "${detections.sku}"
- DATE: "${detections.date}"
- FACTORY / LVL: "${detections.lvl}"
- ALL SIZES (US ${detections.sizes.us}, UK ${detections.sizes.uk}, FR ${detections.sizes.fr}, JP ${detections.sizes.jp})

ONLY UPDATE (MANDATORY CHANGE):
- Brand Serial (Bottom-Left code): "${detections.brandSerial}"
- Reference Serial (Bottom-Right code #): "${detections.reference}"

PHOTOGRAPHIC CONSTRAINTS:
1. RAW LOOK: 12MP smartphone photo with natural grain and lens distortion.
2. NO AI TRACES: No watermarks, no "Generated by" text, no AI artifacts.
3. FONT: Bold Adidas sans-serif.

USER CUSTOM PROMPT:
${customPromptAdidas}
`;
      } else {
        brandPrompt = `
### NEW BALANCE INTERNAL LABEL SPECIFICATIONS
You are recreating a NEW BALANCE tongue label. THIS IS NOT AN ADIDAS LABEL. The architecture is completely different.

GEOMETRY & LAYOUT:
- The text is organized in a strict GRID/TABLE matrix.
- Each size (US, UK, EU, CM) must be in its own defined rectangular box or column.
- The "Style" SKU "${detections.sku}" is typically the most prominent text at the top or bottom left of the grid.

DATA INTEGRITY (STRICT):
- STYLE / MODEL: "${detections.sku}"
- DATE CODE: "${detections.date}"
- FACTORY CODE: "${detections.lvl}"
- SIZES: US ${detections.sizes.us} | UK ${detections.sizes.uk} | EU ${detections.sizes.fr} | CM ${detections.sizes.jp}

PRIMARY MODIFICATIONS (3 CODES):
- SERIAL 1 (12 digits): "${detections.reference}"
- SERIAL 2 (7 digits): "${detections.reference2}"
- ALPHANUMERIC BRAND CODE: "${detections.brandSerial}"

AESTHETIC RULES:
1. MATERIAL: White satin or gloss synthetic material. It reflects light differently than fabric.
2. FONT: Use a heavy, industrial, blocky sans-serif. It is NOT the same as Adidas.
3. LOOK: Recreate a macro photo taken with a phone. Natural focus blur, some grain, maybe a slight crease in the label.
4. NO AI ARTIFACTS: No generic "perfect" white backgrounds. Should look like it's inside a shoe.

USER CUSTOM PROMPT:
${customPromptNB}
`;
      }

      const imagePart = originalImage ? {
        inlineData: {
          mimeType: "image/jpeg",
          data: originalImage.split(',')[1],
        },
      } : null;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            ...(imagePart ? [imagePart] : []),
            { text: brandPrompt }
          ],
        },
        config: {
          imageConfig: {
            aspectRatio: "1:1"
          }
        }
      });

      let foundImage = false;
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          setGeneratedImage(`data:image/png;base64,${part.inlineData.data}`);
          foundImage = true;
          break;
        }
      }

      if (foundImage) {
        setStatus('¡Lengüeta generada con éxito!');
      } else {
        setError('El modelo no devolvió una imagen. Reintentando...');
      }
    } catch (err: any) {
      console.error('Error generating image:', err);
      const msg = err.message || String(err);
      if (msg.includes('401') || msg.toLowerCase().includes('permission denied')) {
        setError('Error de sesión (401) o permisos. Por favor, refresca la página e inténtalo de nuevo.');
      } else if (msg.toLowerCase().includes('quota') || msg.includes('429')) {
        setError('Límite de uso alcanzado (Quota Exceeded). La IA de Google tiene un límite diario de generaciones gratuitas. Por favor, espera unos minutos o intenta mañana.');
      } else {
        setError('Error al generar la imagen: ' + msg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex gap-4">
        {['ADIDAS', 'NEW BALANCE'].map((brand) => (
          <button
            key={brand}
            onClick={() => setActiveBrand(brand as any)}
            className={`flex-1 py-4 rounded-2xl border-2 transition-all font-bold tracking-widest text-sm flex items-center justify-center gap-2 ${
              activeBrand === brand 
                ? 'bg-emerald-500 border-emerald-400 text-black shadow-[0_0_20px_rgba(16,185,129,0.3)]' 
                : 'bg-white/5 border-white/10 text-white/40 hover:bg-white/10 hover:border-white/20'
            }`}
          >
            {brand === 'ADIDAS' ? '/// ADIDAS' : 'NB NEW BALANCE'}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left Side: Upload & OCR */}
        <div className="space-y-6">
          <div
            onClick={() => fileInputRef.current?.click()}
            className={`h-[240px] lg:h-[300px] border-2 border-dashed rounded-3xl flex flex-col items-center justify-center transition-all cursor-pointer overflow-hidden relative group ${
              originalImage ? 'border-emerald-500/50 bg-black' : 'border-white/10 hover:border-white/20 bg-white/5'
            }`}
          >
            {originalImage ? (
              <img src={originalImage} className="w-full h-full object-contain opacity-50 group-hover:opacity-30 transition-opacity" />
            ) : (
              <>
                <Upload className="w-10 h-10 text-white/10 mb-3 group-hover:scale-110 transition-transform" />
                <p className="text-sm text-white/40 font-medium">Subir o fotografiar lengüeta</p>
                <p className="text-[10px] text-white/20 uppercase tracking-widest mt-1 font-mono">JPG, PNG · Cámara disponible</p>
              </>
            )}
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept="image/*"
              capture="environment"
              onChange={handleFileUpload}
            />
          </div>

          <div className="bg-[#141414] border border-white/5 rounded-3xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs uppercase tracking-[0.2em] font-bold text-white/40">Datos Detectados (OCR)</h3>
              {detections && (
                <button onClick={() => setDetections(null)} className="text-[10px] text-emerald-400 hover:underline">Limpiar</button>
              )}
            </div>

            {loading && !detections && (
              <div className="py-8 flex flex-col items-center gap-3">
                <RefreshCcw className="w-6 h-6 text-emerald-500 animate-spin" />
                <span className="text-[10px] text-white/40 animate-pulse uppercase tracking-widest">{status}</span>
              </div>
            )}

            {!loading && !detections && (
              <div className="py-8 text-center border border-dashed border-white/5 rounded-2xl">
                <ScanText className="w-8 h-8 text-white/5 mx-auto mb-2" />
                <p className="text-[11px] text-white/20">Sube una imagen para extraer los datos</p>
              </div>
            )}

            {detections && (
              <motion.div 
                initial={{ opacity: 0 }} 
                animate={{ opacity: 1 }}
                className="grid grid-cols-2 gap-4"
              >
                <div className="space-y-1">
                  <label className="text-[9px] uppercase text-white/30">Modelo</label>
                  <input 
                    value={detections.model} 
                    onChange={e => setDetections({...detections, model: e.target.value})}
                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:border-emerald-500/50 outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] uppercase text-white/30">SKU / Art No</label>
                  <input 
                    value={detections.sku} 
                    onChange={e => setDetections({...detections, sku: e.target.value})}
                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:border-emerald-500/50 outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between items-center">
                    <label className="text-[9px] uppercase text-white/30">
                      {activeBrand === 'ADIDAS' ? 'Referencia #' : 'Referencia 1 (12d)'}
                    </label>
                    <button 
                      onClick={generateRandomReference}
                      className="text-[8px] text-emerald-400 hover:text-emerald-300 uppercase tracking-tighter"
                    >
                      [Random]
                    </button>
                  </div>
                  <input 
                    value={detections.reference} 
                    onChange={e => setDetections({...detections, reference: e.target.value})}
                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:border-emerald-500/50 outline-none font-mono"
                  />
                </div>

                <div className={`space-y-1 ${activeBrand === 'ADIDAS' ? 'opacity-30 pointer-events-none' : ''}`}>
                  <div className="flex justify-between items-center">
                    <label className="text-[9px] uppercase text-white/30">Referencia 2 (7d)</label>
                    <button 
                      onClick={generateRandomReference2}
                      className="text-[8px] text-emerald-400 hover:text-emerald-300 uppercase tracking-tighter"
                    >
                      [Random]
                    </button>
                  </div>
                  <input 
                    value={detections.reference2 || ''} 
                    onChange={e => setDetections({...detections, reference2: e.target.value})}
                    placeholder="Solo NB..."
                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:border-emerald-500/50 outline-none font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between items-center">
                    <label className="text-[9px] uppercase text-white/30">
                      Cód. Marca / Alfanumérico
                    </label>
                    <button 
                      onClick={generateRandomBrandSerial}
                      className="text-[8px] text-emerald-400 hover:text-emerald-300 uppercase tracking-tighter"
                    >
                      [Random]
                    </button>
                  </div>
                  <input 
                    value={detections.brandSerial} 
                    onChange={e => setDetections({...detections, brandSerial: e.target.value})}
                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:border-emerald-500/50 outline-none font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] uppercase text-white/30">Fecha</label>
                  <input 
                    value={detections.date} 
                    onChange={e => setDetections({...detections, date: e.target.value})}
                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:border-emerald-500/50 outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] uppercase text-white/30">LVL / Factory</label>
                  <input 
                    value={detections.lvl} 
                    onChange={e => setDetections({...detections, lvl: e.target.value})}
                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:border-emerald-500/50 outline-none"
                  />
                </div>
                <div className="col-span-2 grid grid-cols-4 gap-2">
                  {(['us', 'uk', 'fr', 'jp'] as const).map(size => (
                    <div key={size} className="space-y-1">
                      <label className="text-[9px] uppercase text-white/30">{size}</label>
                      <input 
                        value={detections.sizes[size]} 
                        onChange={e => setDetections({...detections, sizes: {...detections.sizes, [size]: e.target.value}})}
                        className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-2 text-center text-xs text-white focus:border-emerald-500/50 outline-none uppercase"
                      />
                    </div>
                  ))}
                </div>

                <div className="col-span-2 space-y-3 pt-4 border-t border-white/5">
                  <div className="space-y-1">
                    <div className="flex justify-between items-center">
                      <label className="text-[9px] uppercase text-emerald-400 font-bold">Título del Anuncio (Vinted)</label>
                      <button 
                        onClick={() => {
                          if (detections?.listingTitle) {
                            navigator.clipboard.writeText(detections.listingTitle);
                            setStatus("Título copiado al portapapeles");
                          }
                        }}
                        className="flex items-center gap-1 text-[8px] text-white/40 hover:text-white uppercase tracking-tighter"
                      >
                        <Copy className="w-2 h-2" /> Copiar
                      </button>
                    </div>
                    <input 
                      value={detections.listingTitle || ''} 
                      onChange={e => setDetections({...detections, listingTitle: e.target.value})}
                      className="w-full bg-emerald-500/5 border border-emerald-500/20 rounded-lg px-3 py-2 text-xs text-white focus:border-emerald-500/50 outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between items-center">
                      <label className="text-[9px] uppercase text-emerald-400 font-bold">Descripción del Anuncio</label>
                      <button 
                        onClick={() => {
                          if (detections?.listingDescription) {
                            navigator.clipboard.writeText(detections.listingDescription);
                            setStatus("Descripción copiada al portapapeles");
                          }
                        }}
                        className="flex items-center gap-1 text-[8px] text-white/40 hover:text-white uppercase tracking-tighter"
                      >
                        <Copy className="w-2 h-2" /> Copiar
                      </button>
                    </div>
                    <textarea 
                      value={detections.listingDescription || ''} 
                      onChange={e => setDetections({...detections, listingDescription: e.target.value})}
                      className="w-full bg-emerald-500/5 border border-emerald-500/20 rounded-lg px-3 py-2 text-xs text-white focus:border-emerald-500/50 outline-none h-24 resize-none"
                    />
                  </div>
                </div>

                <div className="col-span-2 space-y-1">
                  <label className="text-[9px] uppercase text-white/30">
                    Prompt de Generación ({activeBrand})
                  </label>
                  <textarea 
                    placeholder={`Pega aquí el prompt personalizado de ${activeBrand}...`}
                    value={activeBrand === 'ADIDAS' ? customPromptAdidas : customPromptNB}
                    onChange={e => activeBrand === 'ADIDAS' ? setCustomPromptAdidas(e.target.value) : setCustomPromptNB(e.target.value)}
                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:border-emerald-500/50 outline-none h-20 resize-none"
                  />
                </div>
              </motion.div>
            )}

            {detections && (
              <button 
                onClick={generateModifiedTongue}
                disabled={loading}
                className="w-full py-4 bg-emerald-500 text-black font-bold rounded-2xl hover:bg-emerald-400 transition-all shadow-[0_0_30px_rgba(16,185,129,0.2)] flex items-center justify-center gap-2 mt-4"
              >
                {loading ? <RefreshCcw className="w-5 h-5 animate-spin" /> : <Scissors className="w-5 h-5" />}
                REGENERAR LENGÜETA
              </button>
            )}
          </div>
        </div>

        {/* Right Side: Result */}
        <div className="space-y-6">
          <div className="bg-[#141414] border border-white/5 rounded-3xl p-8 h-full flex flex-col items-center justify-center relative overflow-hidden group min-h-[500px]">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-500/0 via-emerald-500/50 to-emerald-500/0" />
            
            <AnimatePresence mode="wait">
              {generatedImage ? (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="space-y-6 w-full text-center"
                >
                  <div className="relative inline-block mx-auto">
                    <img 
                      src={generatedImage} 
                      className="max-w-full rounded-2xl shadow-[0_30px_60px_rgba(0,0,0,0.5)] border border-white/10" 
                      alt="Generated"
                    />
                    <div className="absolute inset-0 bg-emerald-500/10 opacity-0 group-hover:opacity-100 transition-opacity rounded-2xl pointer-events-none" />
                  </div>
                  
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex gap-3">
                       <button 
                        onClick={handleDownload}
                        className="px-6 py-3 bg-white text-black font-bold rounded-xl hover:bg-emerald-400 transition-colors flex items-center gap-2"
                       >
                         <Download className="w-4 h-4" /> Bajar Imagen
                       </button>
                       <button 
                        onClick={() => {
                          if (generatedImage) {
                            fetch(generatedImage)
                              .then(res => res.blob())
                              .then(blob => {
                                const item = new ClipboardItem({ "image/png": blob });
                                navigator.clipboard.write([item]);
                                setStatus("Imagen copiada al portapapeles");
                              });
                          }
                        }}
                        className="px-6 py-3 bg-white/10 text-white font-bold rounded-xl hover:bg-white/20 transition-colors flex items-center gap-2"
                       >
                         <Copy className="w-4 h-4" /> Copiar
                       </button>
                    </div>
                    <p className="text-[10px] text-white/20 uppercase tracking-widest font-mono">Archivo Reconstruido - Alta Fidelidad</p>
                  </div>
                </motion.div>
              ) : (
                <div className="text-center space-y-6 opacity-20 group-hover:opacity-40 transition-opacity">
                  <div className="w-24 h-24 bg-white/5 rounded-full flex items-center justify-center mx-auto border border-white/5">
                    <ImageIcon className="w-12 h-12" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-xl font-bold">Vista Previa</h3>
                    <p className="text-xs max-w-[200px] mx-auto">La nueva lengüeta aparecerá aquí después del procesado</p>
                  </div>
                </div>
              )}
            </AnimatePresence>

            {loading && generatedImage && (
              <div className="absolute inset-0 bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center gap-4 z-10">
                <RefreshCcw className="w-10 h-10 text-emerald-500 animate-spin" />
                <p className="text-xs font-bold text-white uppercase tracking-widest">{status}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-2xl p-4 flex gap-4 text-emerald-200/60 text-[11px] leading-relaxed">
        <Info className="w-5 h-5 flex-shrink-0 text-emerald-500" />
        <p>
          Este módulo utiliza Vision-AI para detectar y reconstruir etiquetas de calzado. Al regenerar, 
          Gemini crea una versión sintética limpia basada en los datos extraídos para asegurar neutralidad 
          en auditorías visuales.
        </p>
      </div>
    </div>
  );
}
