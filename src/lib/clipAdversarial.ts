// ─── CLIP adversarial: usa transformers.js para verificar que la imagen
// procesada se ha movido lo suficiente del original en el espacio de
// embeddings de CLIP. Si no, genera más variantes y se queda con la mejor.
//
// IMPORTANTE: transformers.js se carga vía CDN (jsDelivr) en runtime, no se
// bundlea. Esto evita meter el wasm de ONNX (~23 MB) en el bundle de prod.
// El navegador solo descarga la librería cuando el user activa NUCLEAR.

const CDN_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm';
const MODEL_ID = 'Xenova/clip-vit-base-patch32';

interface CLIPModel {
  processor: any;
  model: any;
  RawImage: any;
}

let modelPromise: Promise<CLIPModel> | null = null;

export function isCLIPLoaded(): boolean {
  return modelPromise !== null;
}

export async function loadCLIP(
  onProgress?: (pct: number, file?: string) => void
): Promise<CLIPModel> {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    // Dynamic CDN import — vite no lo bundlea por la URL absoluta.
    const tf: any = await import(/* @vite-ignore */ CDN_URL);
    tf.env.allowLocalModels = false;
    tf.env.useBrowserCache = true;

    const opts: any = {
      progress_callback: (data: any) => {
        if (data.status === 'progress' && typeof data.progress === 'number') {
          onProgress?.(data.progress, data.file);
        } else if (data.status === 'done') {
          onProgress?.(100, data.file);
        }
      },
    };
    const processor = await tf.AutoProcessor.from_pretrained(MODEL_ID, opts);
    const model = await tf.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
      ...opts,
      dtype: 'fp32',
    });
    return { processor, model, RawImage: tf.RawImage };
  })();
  try {
    return await modelPromise;
  } catch (err) {
    modelPromise = null;
    throw err;
  }
}

export async function embedCanvas(canvas: HTMLCanvasElement): Promise<Float32Array> {
  const { processor, model, RawImage } = await loadCLIP();
  // CLIP espera 224×224. Reescala usando un canvas intermedio para evitar
  // que el processor cargue todo el blob de la imagen original.
  const small = document.createElement('canvas');
  small.width = 224; small.height = 224;
  small.getContext('2d')!.drawImage(canvas, 0, 0, 224, 224);
  const raw = await RawImage.fromCanvas(small);
  const inputs = await processor(raw);
  const { image_embeds } = await model(inputs);
  return image_embeds.data as Float32Array;
}

export async function embedDataUrl(dataUrl: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = async () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d')!.drawImage(img, 0, 0);
      try { resolve(await embedCanvas(c)); }
      catch (e) { reject(e); }
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

export function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 1;
  return 1 - dot / denom;
}
