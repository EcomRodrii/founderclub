// ── Client-side barcode generation ─────────────────────────────────────────
// Carga JsBarcode desde CDN (igual que piexifjs) y genera códigos de barras
// CODE128 en un canvas del navegador. El código de barras se superpone sobre
// la imagen de la caja generada por IA.

const JSBARCODE_CDN = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';

let jsBarcodePromise: Promise<void> | null = null;

function loadJsBarcode(): Promise<void> {
  if (!jsBarcodePromise) {
    jsBarcodePromise = new Promise<void>((resolve, reject) => {
      if (typeof (window as any).JsBarcode !== 'undefined') { resolve(); return; }
      const script = document.createElement('script');
      script.src = JSBARCODE_CDN;
      script.onload = () => resolve();
      script.onerror = () => { jsBarcodePromise = null; reject(new Error('JsBarcode CDN failed')); };
      document.head.appendChild(script);
    });
  }
  return jsBarcodePromise;
}

async function renderBarcodeCanvas(
  value: string,
  opts: { lineWidth?: number; barcodeHeight?: number; showText?: boolean } = {}
): Promise<HTMLCanvasElement> {
  await loadJsBarcode();
  const JsBarcode = (window as any).JsBarcode;
  const canvas = document.createElement('canvas');
  JsBarcode(canvas, value, {
    format: 'CODE128',
    width: opts.lineWidth ?? 2,
    height: opts.barcodeHeight ?? 70,
    displayValue: opts.showText ?? true,
    fontSize: 11,
    margin: 8,
    background: '#ffffff',
    lineColor: '#000000',
  });
  return canvas;
}

function waitForImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Overlay barcode onto box label image.
// region = fraction coords { x, y, w, h } relative to image size.
// If no region, barcode is placed at the bottom-center of the image.
export async function overlayBarcode(
  boxImageDataUrl: string,
  barcodeValue: string,
  region?: { x: number; y: number; w: number; h: number }
): Promise<string> {
  const img = await waitForImage(boxImageDataUrl);

  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  // Target region on canvas (pixels)
  const rx = region ? Math.round(region.x * canvas.width)  : Math.round(canvas.width * 0.15);
  const ry = region ? Math.round(region.y * canvas.height) : Math.round(canvas.height * 0.72);
  const rw = region ? Math.round(region.w * canvas.width)  : Math.round(canvas.width * 0.70);
  const rh = region ? Math.round(region.h * canvas.height) : Math.round(canvas.height * 0.18);

  // White background first
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(rx - 4, ry - 4, rw + 8, rh + 8);

  // Generate barcode sized to fit region
  const barcodeCanvas = await renderBarcodeCanvas(barcodeValue, {
    lineWidth: Math.max(1, Math.floor(rw / 80)),
    barcodeHeight: rh - 18,
    showText: true,
  });

  // Center barcode inside region
  const bx = rx + Math.round((rw - barcodeCanvas.width) / 2);
  const by = ry + Math.round((rh - barcodeCanvas.height) / 2);
  ctx.drawImage(barcodeCanvas, bx, by);

  return canvas.toDataURL('image/jpeg', 0.87);
}

// Generate a barcode-only data URL (no compositing — for preview)
export async function generateBarcodeDataUrl(value: string): Promise<string> {
  const canvas = await renderBarcodeCanvas(value, { lineWidth: 2, barcodeHeight: 80 });
  return canvas.toDataURL('image/png');
}
