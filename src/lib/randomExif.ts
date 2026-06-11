// ─── Random EXIF injection ────────────────────────────────────────────────
// Inyecta metadatos EXIF realistas (fabricante, modelo, fecha, ISO, focal…)
// en un JPEG dataURL. Hace que la foto parezca tomada con un móvil real en
// vez de un JPEG limpio "AI-procesado".
//
// piexifjs se carga vía CDN (dynamic import) para no bundlearlo.
// Solo se descarga si el user activa el modo EXTREMO.

const PIEXIF_CDN = 'https://cdn.jsdelivr.net/npm/piexifjs@1.0.6/+esm';

let piexifPromise: Promise<any> | null = null;
async function loadPiexif(): Promise<any> {
  if (!piexifPromise) {
    piexifPromise = import(/* @vite-ignore */ PIEXIF_CDN)
      .then(m => m.default || m)
      .catch(err => { piexifPromise = null; throw err; });
  }
  return piexifPromise;
}

// Pool de cámaras móviles reales — selecciona una al azar por foto.
const DEVICES: { make: string; model: string; software: string; focalLengthMm: number; fNumber: [number, number] }[] = [
  { make: 'Apple',   model: 'iPhone 13',         software: '17.2.1',   focalLengthMm: 26, fNumber: [16, 10] },
  { make: 'Apple',   model: 'iPhone 14 Pro',     software: '17.3',     focalLengthMm: 24, fNumber: [178, 100] },
  { make: 'Apple',   model: 'iPhone 12',         software: '16.7.4',   focalLengthMm: 26, fNumber: [16, 10] },
  { make: 'Apple',   model: 'iPhone 15',         software: '17.4',     focalLengthMm: 24, fNumber: [16, 10] },
  { make: 'Apple',   model: 'iPhone 11',         software: '16.5',     focalLengthMm: 26, fNumber: [18, 10] },
  { make: 'samsung', model: 'SM-G991B',          software: 'G991BXXSDFWA2', focalLengthMm: 26, fNumber: [18, 10] }, // Galaxy S21
  { make: 'samsung', model: 'SM-S908B',          software: 'S908BXXSCEXJ2', focalLengthMm: 23, fNumber: [18, 10] }, // S22 Ultra
  { make: 'samsung', model: 'SM-S918B',          software: 'S918BXXS8DXG1', focalLengthMm: 23, fNumber: [17, 10] }, // S23 Ultra
  { make: 'Google',  model: 'Pixel 7',           software: 'TQ3A.230901.001', focalLengthMm: 25, fNumber: [185, 100] },
  { make: 'Google',  model: 'Pixel 6a',          software: 'TQ3A.230901.001', focalLengthMm: 27, fNumber: [17, 10] },
  { make: 'Xiaomi',  model: '23021RAAEG',        software: 'V14.0.5.0',   focalLengthMm: 24, fNumber: [175, 100] },
];

function randInt(min: number, max: number) { return Math.floor(min + Math.random() * (max - min + 1)); }
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

// Devuelve "YYYY:MM:DD HH:MM:SS" — formato EXIF estándar.
// Random entre hace 3 días y hace 60 días (rango creíble para una foto reciente).
function randomExifDate(): string {
  const now = Date.now();
  const minMs = 3 * 24 * 60 * 60 * 1000;
  const maxMs = 60 * 24 * 60 * 60 * 1000;
  const offset = randInt(minMs, maxMs);
  const d = new Date(now - offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Perfil EXIF: todos los valores aleatorios generados de una vez.
// Permite aplicar el mismo perfil a varias fotos del mismo lote.
export interface ExifProfile {
  device: typeof DEVICES[0];
  date: string;
  iso: number;
  exposureNum: number;
  exposureDen: number;
}

export function generateExifProfile(): ExifProfile {
  return {
    device:      pick(DEVICES),
    date:        randomExifDate(),
    iso:         pick([100, 125, 160, 200, 250, 320, 400, 500, 640, 800]),
    exposureNum: pick([1, 1, 1, 1, 1, 2, 3]),
    exposureDen: pick([15, 30, 60, 100, 125, 160, 200, 250, 320, 500]),
  };
}

// Aplica un perfil EXIF concreto a un JPEG dataURL.
export async function injectExifProfile(jpegDataUrl: string, profile: ExifProfile): Promise<string> {
  try {
    const piexif = await loadPiexif();
    const { device: dev, date, iso, exposureNum, exposureDen } = profile;

    const zerothIfd: any = {
      [piexif.ImageIFD.Make]: dev.make,
      [piexif.ImageIFD.Model]: dev.model,
      [piexif.ImageIFD.Software]: dev.software,
      [piexif.ImageIFD.DateTime]: date,
      [piexif.ImageIFD.Orientation]: 1,
      [piexif.ImageIFD.XResolution]: [72, 1],
      [piexif.ImageIFD.YResolution]: [72, 1],
      [piexif.ImageIFD.ResolutionUnit]: 2,
      [piexif.ImageIFD.YCbCrPositioning]: 1,
    };
    const exifIfd: any = {
      [piexif.ExifIFD.DateTimeOriginal]: date,
      [piexif.ExifIFD.DateTimeDigitized]: date,
      [piexif.ExifIFD.ExposureTime]: [exposureNum, exposureDen],
      [piexif.ExifIFD.FNumber]: dev.fNumber,
      [piexif.ExifIFD.ISOSpeedRatings]: iso,
      [piexif.ExifIFD.FocalLength]: [dev.focalLengthMm, 1],
      [piexif.ExifIFD.FocalLengthIn35mmFilm]: dev.focalLengthMm,
      [piexif.ExifIFD.ExposureProgram]: 2,
      [piexif.ExifIFD.MeteringMode]: pick([2, 3, 5]),
      [piexif.ExifIFD.Flash]: pick([0, 16, 24]),
      [piexif.ExifIFD.WhiteBalance]: 0,
      [piexif.ExifIFD.ExifVersion]: '0231',
      [piexif.ExifIFD.ColorSpace]: 1,
      [piexif.ExifIFD.LensMake]: dev.make,
      [piexif.ExifIFD.LensModel]: `${dev.model} back camera`,
      [piexif.ExifIFD.SceneCaptureType]: 0,
    };
    const exifStr = piexif.dump({ '0th': zerothIfd, 'Exif': exifIfd });
    return piexif.insert(exifStr, jpegDataUrl);
  } catch (err) {
    console.warn('[exif] inyección falló, devuelvo sin EXIF:', err);
    return jpegDataUrl;
  }
}

// Genera un perfil aleatorio y lo aplica. Mantiene compatibilidad con código existente.
export async function injectRandomExif(jpegDataUrl: string): Promise<string> {
  return injectExifProfile(jpegDataUrl, generateExifProfile());
}

// Clona los metadatos EXIF de una foto real (sourceJpegDataUrl) e inyecta
// exactamente los mismos metadatos en el JPEG de destino.
// Si la fuente no tiene EXIF de cámara o el proceso falla, recurre a
// injectRandomExif como fallback silencioso.
export async function cloneExifFrom(
  sourceJpegDataUrl: string,
  targetJpegDataUrl: string
): Promise<string> {
  try {
    const piexif = await loadPiexif();
    const srcExif = piexif.load(sourceJpegDataUrl);
    // Verificar que la fuente tiene EXIF real de cámara (tiene campo Make)
    const hasMake = srcExif['0th']?.[piexif.ImageIFD.Make];
    if (!hasMake) {
      console.warn('[exif] fuente sin EXIF de cámara, usando EXIF aleatorio');
      return injectRandomExif(targetJpegDataUrl);
    }
    return piexif.insert(piexif.dump(srcExif), targetJpegDataUrl);
  } catch (err) {
    console.warn('[exif] clon EXIF falló, usando EXIF aleatorio:', err);
    return injectRandomExif(targetJpegDataUrl);
  }
}
