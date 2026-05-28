// ── Client-side barcode generation — photorealistic compositing ──────────
// Detecta automáticamente la zona blanca que Gemini dejó en la imagen de
// la caja, genera un código de barras CODE128 proporcional y lo fusiona
// usando blend Multiply + ruido de papel muestreado del entorno.
// Resultado: el barcode parece imprimido en el mismo papel, no pegado encima.

const JSBARCODE_CDN = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';
let jsBarcodePromise: Promise<void> | null = null;

function loadJsBarcode(): Promise<void> {
  if (!jsBarcodePromise) {
    jsBarcodePromise = new Promise<void>((resolve, reject) => {
      if (typeof (window as any).JsBarcode !== 'undefined') { resolve(); return; }
      const s = document.createElement('script');
      s.src = JSBARCODE_CDN;
      s.onload = () => resolve();
      s.onerror = () => { jsBarcodePromise = null; reject(new Error('JsBarcode CDN failed')); };
      document.head.appendChild(s);
    });
  }
  return jsBarcodePromise;
}

interface Region { x: number; y: number; w: number; h: number; }

// ── Detección de la zona más blanca ──────────────────────────────────────
// Calcula la luminosidad media por fila y busca la franja horizontal más
// blanca y ancha (la zona que Gemini dejó vacía para el barcode).
function detectWhiteZone(ctx: CanvasRenderingContext2D, W: number, H: number): Region {
  const data = ctx.getImageData(0, 0, W, H).data;

  // Luminosidad media normalizada (0-1) por fila
  const rowLum = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let sum = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    }
    rowLum[y] = sum / W / 255;
  }

  // Encontrar la racha de filas con lum > 0.87 más larga
  const WHITE = 0.87;
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let y = 0; y < H; y++) {
    if (rowLum[y] >= WHITE) {
      if (curStart === -1) curStart = y;
      curLen++;
    } else {
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
      curStart = -1; curLen = 0;
    }
  }
  if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }

  // Fallback si no hay zona blanca suficientemente grande
  if (bestStart === -1 || bestLen < H * 0.06) {
    return { x: Math.round(W * 0.12), y: Math.round(H * 0.70), w: Math.round(W * 0.76), h: Math.round(H * 0.16) };
  }

  // Extensión horizontal en la fila central de la zona blanca
  const midY = bestStart + Math.floor(bestLen / 2);
  let minX = W, maxX = 0;
  for (let x = 0; x < W; x++) {
    const i = (midY * W + x) * 4;
    if ((data[i] + data[i + 1] + data[i + 2]) / 3 / 255 >= WHITE) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }

  if (maxX <= minX) {
    return { x: Math.round(W * 0.12), y: Math.round(H * 0.70), w: Math.round(W * 0.76), h: Math.round(H * 0.16) };
  }

  const pad = 3;
  return {
    x: Math.max(0, minX - pad),
    y: Math.max(0, bestStart - pad),
    w: Math.min(W, maxX - minX + pad * 2),
    h: Math.min(H, bestLen + pad * 2),
  };
}

// ── Estadísticas del papel circundante ───────────────────────────────────
// Muestrea los píxeles JUSTO encima de la zona detectada para obtener
// el color promedio del papel y el nivel de ruido real de la foto.
function samplePaperStats(
  data: Uint8ClampedArray, W: number, H: number, region: Region
): { r: number; g: number; b: number; noise: number } {
  const sampleY = region.y - 8;
  if (sampleY < 0) return { r: 245, g: 242, b: 238, noise: 8 };

  const samples: number[] = [];
  const step = Math.max(1, Math.floor(region.w / 30));
  for (let x = region.x; x < region.x + region.w; x += step) {
    const i = (sampleY * W + x) * 4;
    samples.push(data[i], data[i + 1], data[i + 2]);
  }
  if (samples.length === 0) return { r: 245, g: 242, b: 238, noise: 8 };

  const avgR = samples.filter((_, i) => i % 3 === 0).reduce((a, b) => a + b, 0) / (samples.length / 3);
  const avgG = samples.filter((_, i) => i % 3 === 1).reduce((a, b) => a + b, 0) / (samples.length / 3);
  const avgB = samples.filter((_, i) => i % 3 === 2).reduce((a, b) => a + b, 0) / (samples.length / 3);

  const rSamples = samples.filter((_, i) => i % 3 === 0);
  const variance = rSamples.reduce((s, v) => s + (v - avgR) ** 2, 0) / rSamples.length;
  const noise = Math.max(5, Math.min(22, Math.sqrt(variance)));

  return { r: Math.round(avgR), g: Math.round(avgG), b: Math.round(avgB), noise };
}

// ── Generador de barcode interno ──────────────────────────────────────────
async function renderBarcodeCanvas(
  value: string,
  lineWidth: number,
  barcodeHeight: number
): Promise<HTMLCanvasElement> {
  await loadJsBarcode();
  const canvas = document.createElement('canvas');
  (window as any).JsBarcode(canvas, value, {
    format: 'CODE128',
    width: lineWidth,
    height: barcodeHeight,
    displayValue: true,
    fontSize: Math.max(9, Math.round(barcodeHeight * 0.18)),
    margin: 6,
    background: '#ffffff',
    lineColor: '#000000',
    textMargin: 3,
  });
  return canvas;
}

function waitImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

// ── Overlay principal ─────────────────────────────────────────────────────
// 1. Dibuja imagen de caja en canvas
// 2. Detecta zona blanca automáticamente (o usa region manual si se provee)
// 3. Tinta fondo con color de papel muestreado del entorno
// 4. Dibuja barcode con globalCompositeOperation='multiply' →
//    blanco del barcode adopta textura del papel, negro queda negro
// 5. Aplica ruido idéntico al del papel circundante
// 6. Re-codifica como JPEG 0.87
export async function overlayBarcode(
  boxImageDataUrl: string,
  barcodeValue: string,
  manualRegion?: { x: number; y: number; w: number; h: number }
): Promise<string> {
  const img = await waitImg(boxImageDataUrl);
  const W = img.width, H = img.height;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  // Detectar zona (manual override o auto)
  const region: Region = manualRegion
    ? {
        x: Math.round(manualRegion.x * W),
        y: Math.round(manualRegion.y * H),
        w: Math.round(manualRegion.w * W),
        h: Math.round(manualRegion.h * H),
      }
    : detectWhiteZone(ctx, W, H);

  // Muestrar papel circundante ANTES de modificar el canvas
  const paper = samplePaperStats(ctx.getImageData(0, 0, W, H).data, W, H, region);

  // Rellenar zona con color del papel (no blanco puro)
  // Esto hace que el fondo del barcode tenga la misma tonalidad que el papel
  const paperWhite = `rgb(${Math.min(255, paper.r + 8)},${Math.min(255, paper.g + 6)},${Math.min(255, paper.b + 4)})`;
  ctx.fillStyle = paperWhite;
  ctx.fillRect(region.x, region.y, region.w, region.h);

  // Generar barcode proporcional a la zona detectada
  // Altura: 75% del alto de la zona. Ancho: JsBarcode lo calcula solo.
  const barcodeHeight = Math.round(region.h * 0.72);
  const lineW = Math.max(1, Math.min(3, Math.round(region.w / 90)));
  const barcodeCanvas = await renderBarcodeCanvas(barcodeValue, lineW, barcodeHeight);

  // Centrar barcode en la región
  const bx = region.x + Math.round((region.w - barcodeCanvas.width) / 2);
  const by = region.y + Math.round((region.h - barcodeCanvas.height) / 2);

  // MULTIPLY BLEND: negro del barcode queda negro; blanco del barcode
  // se multiplica por el fondo de papel → adopta su textura y tonalidad.
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(barcodeCanvas, bx, by);
  ctx.globalCompositeOperation = 'source-over';

  // Aplicar ruido de papel a TODA la zona (iguala firma estadística)
  const zoneData = ctx.getImageData(region.x, region.y, region.w, region.h);
  const zd = zoneData.data;
  const noiseAmp = paper.noise * 1.1; // ligeramente más para compensar el multiply
  for (let i = 0; i < zd.length; i += 4) {
    const n = (Math.random() - 0.5) * noiseAmp;
    zd[i]     = Math.min(255, Math.max(0, zd[i]     + n));
    zd[i + 1] = Math.min(255, Math.max(0, zd[i + 1] + n * 0.97));
    zd[i + 2] = Math.min(255, Math.max(0, zd[i + 2] + n * 0.95));
  }
  ctx.putImageData(zoneData, region.x, region.y);

  return canvas.toDataURL('image/jpeg', 0.87);
}

// Genera solo el barcode como data URL (para previsualización standalone)
export async function generateBarcodeDataUrl(value: string): Promise<string> {
  await loadJsBarcode();
  const canvas = document.createElement('canvas');
  (window as any).JsBarcode(canvas, value, {
    format: 'CODE128', width: 2, height: 80, displayValue: true,
    fontSize: 14, margin: 8, background: '#ffffff', lineColor: '#000000',
  });
  return canvas.toDataURL('image/png');
}
