import React, { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Upload, Download, Image as ImageIcon,
  CheckCircle2, RefreshCcw, Trash2, Shuffle,
  ZapOff, Images, Plus, Pencil, ChevronDown, ChevronUp, RotateCcw
} from 'lucide-react';

// ─── Cómo detecta Vinted duplicados ──────────────────────────────────────────
//
// PASO 1 — pHash (perceptual hash):
//   Reduce la imagen a 32×32 gris, aplica DCT, hashea coeficientes.
//   Hamming distance < 10 bits = "duplicado".
//   Se rompe con: crop+resize (cambia toda la estructura espacial).
//
// PASO 2 — CNN embedding (modelo de IA tipo ResNet/EfficientNet fashion):
//   Extrae vector de 512-2048 dimensiones. Cosine similarity > 0.85 = duplicado.
//   Lo que hace el modelo: divide la imagen en PARCHES (patches) y extrae
//   características locales de cada parche (textura, forma, color local).
//   Se rompe con: ruido por bloques independientes — cada parche de la CNN
//   ve estadísticas diferentes aunque el ojo humano no note nada.
//
// PASO 3 — Color histogram:
//   Compara distribución global de colores. MUY rápido, poco eficaz.
//   → NO hace falta rotar hue (eso cambia colores visiblemente).
//   Se rompe con: variación de brillo por bloques (cambia histograma local).
//
// SOLUCIÓN invisible:
//   1. Crop+resize pequeño (1-5%)  → derrota pHash completamente.
//   2. Ruido por bloques NxN independiente (±3-5 por bloque) → derrota CNN.
//   3. Ondulación sinusoidal por filas (±1-2px) → cambia layout espacial.
//   4. Variación JPEG quality → artefactos de compresión únicos.
//   ★ SIN rotación de color → la foto queda visualmente idéntica.

type Mode = 'suave' | 'normal' | 'fuerte' | 'extremo';

interface ModeConfig {
  id: Mode; label: string; desc: string;
  // Trim de bordes (px)
  trimMin: number; trimMax: number;
  // Crop+resize (% de cada lado) → rompe pHash
  cropPctMin: number; cropPctMax: number;
  // Ruido global por canal (muy pequeño, base)
  pixelNoiseMax: number;
  // Ruido por bloque NxN independiente → rompe CNN patches
  blockNoiseMax: number;
  blockSize: number;
  // Ondulación sinusoidal por filas (px) → cambia layout espacial
  lineWarpMax: number;
  // Brillo global leve (invisible)
  brightMax: number;
  // Gradiente muy sutil corner-to-corner (invisible)
  gradientMax: number;
  // Micro-rotación geométrica
  rotateDegMax: number;
  // Calidad JPEG
  qualityMin: number; qualityMax: number;
  // Probabilidad 0..1 de flip horizontal (espejo) → rompe embedding CNN entero
  flipChance: number;
  // Variación máxima de aspect ratio (0.04 = ±4% en cada eje)
  aspectStretchMax: number;
  // Desplazamiento máximo de cada esquina (px) para perspective warp → rompe SIFT
  perspectiveMax: number;
  // Shift de color del fondo detectado (±/canal RGB) → elimina keypoints estables
  bgShiftMax: number;
  // Distancia RGB para considerar un pixel "fondo" (similar a las esquinas)
  bgTolerance: number;
  // Amplitud de overlay de ruido baja-frecuencia → añade keypoints fake
  textureAmp: number;
  // Off-center crop: si > 0, recorta una ventana de (min..max) fracción del original
  // y la posiciona aleatoriamente (no centrada). Cambia qué patches dominan el ViT.
  offCenterKeepMin: number;
  offCenterKeepMax: number;
  // Tone curve S-shape amplitude (0..30). Curva no-lineal por canal RGB.
  toneCurveAmp: number;
  // Probabilidad 0..1 de superponer un distractor (mano/percha/sticker).
  // Añade un concepto semántico nuevo al embedding CLIP.
  distractorChance: number;
  // Si true, inyecta EXIF aleatorio realista (cámara, fecha, ISO, focal…).
  // Hace que la foto parezca tomada con móvil en vez de JPEG limpio.
  randomExif: boolean;
  // Sesgar (skew) horizontal/vertical. Valores en "unidades" (0.5 ≈ leve, 2 ≈ fuerte).
  // Se aplica como transformación afín antes del draw. Cambia la geometría sin rotar.
  skewX?: number;
  skewY?: number;
  // Marco (crop) independiente por eje. Si están definidos, sobreescriben cropPctMin/Max.
  // % de borde recortado en cada eje. P.ej. frameVPct=0, frameHPct=10 → solo recorta laterales.
  frameVPct?: number;
  frameHPct?: number;
}

const MODES: ModeConfig[] = [
  {
    id: 'suave', label: 'SUAVE',
    desc: 'Foto visualmente idéntica. Cambia solo el hash binario.',
    trimMin: 1, trimMax: 2,
    cropPctMin: 0.3, cropPctMax: 1.0,
    pixelNoiseMax: 1,
    blockNoiseMax: 1, blockSize: 24,
    lineWarpMax: 0,
    brightMax: 0,
    gradientMax: 0,
    rotateDegMax: 0,
    qualityMin: 0.94, qualityMax: 0.97,
    flipChance: 0,
    aspectStretchMax: 0,
    perspectiveMax: 0,
    bgShiftMax: 0,
    bgTolerance: 0,
    textureAmp: 0,
    offCenterKeepMin: 0,
    offCenterKeepMax: 0,
    toneCurveAmp: 0,
    distractorChance: 0,
    randomExif: false,
  },
  {
    id: 'normal', label: 'NORMAL',
    desc: 'Equilibrio perfecto. Recomendado para uso diario.',
    trimMin: 1, trimMax: 3,
    cropPctMin: 0.5, cropPctMax: 2.0,
    pixelNoiseMax: 1,
    blockNoiseMax: 2, blockSize: 20,
    lineWarpMax: 0,
    brightMax: 3,
    gradientMax: 0,
    rotateDegMax: 0,
    qualityMin: 0.90, qualityMax: 0.94,
    flipChance: 0,
    aspectStretchMax: 0,
    perspectiveMax: 0,
    bgShiftMax: 0,
    bgTolerance: 0,
    textureAmp: 0,
    offCenterKeepMin: 0,
    offCenterKeepMax: 0,
    toneCurveAmp: 0,
    distractorChance: 0,
    randomExif: false,
  },
  {
    id: 'fuerte', label: 'FUERTE',
    desc: 'Invisible al ojo. Rompe pHash + embedding CNN.',
    trimMin: 2, trimMax: 4,
    cropPctMin: 1.0, cropPctMax: 3.0,
    pixelNoiseMax: 2,
    blockNoiseMax: 2, blockSize: 16,
    lineWarpMax: 1,
    brightMax: 4,
    gradientMax: 4,
    rotateDegMax: 0.3,
    qualityMin: 0.87, qualityMax: 0.92,
    flipChance: 0,
    aspectStretchMax: 0,
    perspectiveMax: 0,
    bgShiftMax: 0,
    bgTolerance: 0,
    textureAmp: 0,
    offCenterKeepMin: 0,
    offCenterKeepMax: 0,
    toneCurveAmp: 0,
    distractorChance: 0,
    randomExif: false,
  },
  {
    id: 'extremo', label: 'EXTREMO',
    desc: 'Flip horizontal + EXIF aleatorio + crop sutil. Presentable y discreto.',
    trimMin: 2, trimMax: 4,
    cropPctMin: 3, cropPctMax: 8,
    pixelNoiseMax: 2,
    blockNoiseMax: 2, blockSize: 16,
    lineWarpMax: 1,
    brightMax: 3,
    gradientMax: 3,
    rotateDegMax: 0.3,
    qualityMin: 0.87, qualityMax: 0.93,
    flipChance: 0.5,
    aspectStretchMax: 0.02,
    perspectiveMax: 5,
    bgShiftMax: 0,        // Off — cambiaba el fondo de color
    bgTolerance: 0,
    textureAmp: 0,        // Off — añadía granulado visible
    offCenterKeepMin: 0,  // Off — encuadre off-center quedaba raro
    offCenterKeepMax: 0,
    toneCurveAmp: 0,      // Off — alteraba color del producto
    distractorChance: 0,  // Off — emoji muy visible
    randomExif: true,     // On — EXIF aleatorio realista
  },
];

const TECHNIQUES: Record<Mode, { icon: string; title: string; detail: string }[]> = {
  suave: [
    { icon: '✓', title: 'Crop + resize mínimo', detail: 'Recorta 0.5-1.5% de bordes y reescala. pHash completamente diferente.' },
    { icon: '✓', title: 'Ruido por bloques', detail: 'Bloques 16×16 con offset independiente ±2. Parches CNN diferentes.' },
    { icon: '✓', title: 'Ruido global sub-visual', detail: '±1px por canal. MD5/SHA únicos. El ojo no lo ve.' },
    { icon: '✓', title: 'JPEG variable', detail: 'Calidad 93-96%. Artefactos de compresión únicos.' },
    { icon: '✓', title: 'Sin EXIF', detail: 'GPS, fecha, cámara, software. Todo eliminado.' },
  ],
  normal: [
    { icon: '✓', title: 'Crop + resize', detail: 'Recorta 1-3% y reescala. Destruye pHash. Invisible a ojo.' },
    { icon: '✓', title: 'Ruido por bloques 16×16', detail: 'Cada patch de la CNN ve estadísticas distintas. ±3 por bloque.' },
    { icon: '✓', title: 'Ondulación por filas ±1px', detail: 'Desplaza cada fila ±1px sinusoidal. Layout espacial único.' },
    { icon: '✓', title: 'Brillo micro-variación', detail: '±4 uniforme. Barely visible.' },
    { icon: '✓', title: 'JPEG variable', detail: 'Calidad 88-93%. Hash binario único.' },
    { icon: '✓', title: 'Sin EXIF', detail: 'Todos los metadatos eliminados.' },
  ],
  fuerte: [
    { icon: '✓', title: 'Crop + resize 2-5%', detail: 'Recorte asimétrico y reescalado. pHash hamming distance máxima.' },
    { icon: '✓', title: 'Ruido por bloques 12×12', detail: 'Bloques más pequeños = más parches afectados. Embedding CNN falla.' },
    { icon: '✓', title: 'Ondulación sinusoidal por filas', detail: 'Cada fila desplazada ±1px. Frecuencia y fase aleatorias.' },
    { icon: '✓', title: 'Micro-rotación ±0.4°', detail: 'Invisible. Cambia coordenadas de cada píxel.' },
    { icon: '✓', title: 'Gradiente ultra-sutil', detail: '±6 corner-to-corner. Indetectable visualmente.' },
    { icon: '✓', title: 'Ruido global ±3px', detail: 'Por canal RGB. MD5/SHA únicos.' },
    { icon: '✓', title: 'JPEG variable 83-90%', detail: 'Artefactos de cuantización únicos por imagen.' },
    { icon: '✓', title: 'Sin EXIF', detail: 'Todos los metadatos eliminados.' },
  ],
  extremo: [
    { icon: '🎯', title: 'Flip horizontal 50% prob', detail: 'Espejo aleatorio. Cambia el embedding sin alterar la imagen del producto.' },
    { icon: '🎯', title: 'EXIF aleatorio realista', detail: 'iPhone/Samsung/Pixel reales + fecha + ISO + focal. La foto parece tomada con móvil.' },
    { icon: '✓', title: 'Crop sutil 3-8%', detail: 'Recorte simétrico moderado + reescalado. Encuadre presentable.' },
    { icon: '✓', title: 'Aspect ratio ±2%', detail: 'Variación mínima de proporciones, imperceptible.' },
    { icon: '✓', title: 'Perspective warp ±5px', detail: 'Esquinas levemente desplazadas. Geometría única por imagen.' },
    { icon: '✓', title: 'Ruido por bloques 16×16', detail: 'Cada parche del ViT ve estadísticas distintas, invisible al ojo.' },
    { icon: '✓', title: 'Ondulación sinusoidal ±1px', detail: 'Layout espacial único por imagen.' },
    { icon: '✓', title: 'Micro-rotación ±0.3°', detail: 'Submilimétrica, invisible.' },
    { icon: '✓', title: 'Brillo + gradiente ±3', detail: 'Sub-visual.' },
    { icon: '✓', title: 'JPEG variable 87-93%', detail: 'Calidad alta, artefactos únicos.' },
  ],
};

// ─── Motor principal ──────────────────────────────────────────────────────────

async function uniquifyImage(
  file: File,
  cfg: ModeConfig
): Promise<{ dataUrl: string; noiseLevel: number; dimChange: string; size: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = async () => {
        const rnd  = (a: number, b: number) => a + Math.random() * (b - a);
        const rndI = (a: number, b: number) => Math.floor(rnd(a, b + 1));
        const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));

        const IW = img.width, IH = img.height;

        // ── 1. Crop (derrota pHash, y opcionalmente CLIP via re-encuadre) ─
        let srcX = 0, srcY = 0, srcW = IW, srcH = IH;
        if (cfg.offCenterKeepMin > 0 && cfg.offCenterKeepMax > 0) {
          // Off-center: ventana de tamaño (keepMin..keepMax) colocada en pos aleatoria.
          // Cambia qué patches dominan el ViT de CLIP → embedding diferente.
          const rW = rnd(cfg.offCenterKeepMin, cfg.offCenterKeepMax);
          const rH = rnd(cfg.offCenterKeepMin, cfg.offCenterKeepMax);
          srcW = Math.max(1, Math.floor(IW * rW));
          srcH = Math.max(1, Math.floor(IH * rH));
          srcX = rndI(0, IW - srcW);
          srcY = rndI(0, IH - srcH);
        } else if (cfg.cropPctMax > 0) {
          // Crop simétrico clásico: recorta X% de bordes y reescala.
          const pct  = rnd(cfg.cropPctMin, cfg.cropPctMax) / 100;
          const maxX = Math.floor(IW * pct);
          const maxY = Math.floor(IH * pct);
          srcX = rndI(0, maxX);
          srcY = rndI(0, maxY);
          srcW = IW - srcX - rndI(0, maxX - srcX < 0 ? 0 : maxX - srcX);
          srcH = IH - srcY - rndI(0, maxY - srcY < 0 ? 0 : maxY - srcY);
          srcW = Math.max(srcW, Math.floor(IW * 0.85));
          srcH = Math.max(srcH, Math.floor(IH * 0.85));
        }

        // ── 2. Dimensiones finales (trim adicional + aspect stretch) ──────
        const trimW = rndI(cfg.trimMin, cfg.trimMax);
        const trimH = rndI(cfg.trimMin, cfg.trimMax);
        let W = Math.max(srcW - trimW, 1);
        let H = Math.max(srcH - trimH, 1);

        // Aspect ratio: estira ancho y alto independientes (cambia proporciones).
        if (cfg.aspectStretchMax > 0) {
          const wS = 1 + rnd(-cfg.aspectStretchMax, cfg.aspectStretchMax);
          const hS = 1 + rnd(-cfg.aspectStretchMax, cfg.aspectStretchMax);
          W = Math.max(1, Math.round(W * wS));
          H = Math.max(1, Math.round(H * hS));
        }

        // Flip horizontal aleatorio: la bala de plata contra embeddings CNN.
        const flipH = Math.random() < (cfg.flipChance || 0);

        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d')!;

        // ── 3. Flip + micro-rotación (opcional) ───────────────────────────
        ctx.save();
        if (flipH) {
          ctx.translate(W, 0);
          ctx.scale(-1, 1);
        }
        if (cfg.rotateDegMax > 0) {
          const angle = rnd(-cfg.rotateDegMax, cfg.rotateDegMax) * Math.PI / 180;
          const ac = Math.abs(Math.cos(angle)), as = Math.abs(Math.sin(angle));
          // Escala correcta para imágenes rectangulares: agranda la imagen (>1) para
          // que la imagen rotada CUBRA todas las esquinas del canvas sin bordes negros.
          // La fórmula 1/(cos+sin) solo funciona para cuadrados; fotos portrait/landscape
          // con esa fórmula dejan esquinas vacías que el JPEG rellena de negro.
          const scale = Math.max(ac + (H / W) * as, (W / H) * as + ac);
          ctx.translate(W / 2, H / 2);
          ctx.rotate(angle);
          ctx.scale(scale, scale);
          ctx.translate(-W / 2, -H / 2);
        }
        // Skew (sesgar) X/Y: escala compensada para fotos rectangulares.
        const skX = (cfg.skewX ?? 0) * 0.05;
        const skY = (cfg.skewY ?? 0) * 0.05;
        if (skX !== 0 || skY !== 0) {
          // scaleComp > 1: agranda la imagen para que el shear cubra todas las esquinas.
          const scaleComp = 1 + Math.abs(skX) * (H / W) + Math.abs(skY) * (W / H);
          ctx.translate(W / 2, H / 2);
          ctx.transform(1, skY, skX, 1, 0, 0);
          ctx.scale(scaleComp, scaleComp);
          ctx.translate(-W / 2, -H / 2);
        }
        ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, W, H);
        ctx.restore();

        // ── 3b. Perspective warp (derrota SIFT/ORB) ───────────────────────
        // Bilinear quad warp: cada esquina se desplaza independientemente.
        // SIFT/ORB son invariantes a rotación y escala, pero NO a perspectiva.
        // Cambia las coordenadas geométricas de cada keypoint → no matchea.
        if (cfg.perspectiveMax > 0) {
          const pAmp = cfg.perspectiveMax;
          const dTLx = rnd(-pAmp, pAmp), dTLy = rnd(-pAmp, pAmp);
          const dTRx = rnd(-pAmp, pAmp), dTRy = rnd(-pAmp, pAmp);
          const dBLx = rnd(-pAmp, pAmp), dBLy = rnd(-pAmp, pAmp);
          const dBRx = rnd(-pAmp, pAmp), dBRy = rnd(-pAmp, pAmp);
          const srcP = ctx.getImageData(0, 0, W, H);
          const dstP = ctx.createImageData(W, H);
          const sd = srcP.data, dd = dstP.data;
          const wm1 = W - 1, hm1 = H - 1;
          for (let y = 0; y < H; y++) {
            const v = hm1 > 0 ? y / hm1 : 0;
            const inv1v = 1 - v;
            for (let x = 0; x < W; x++) {
              const u = wm1 > 0 ? x / wm1 : 0;
              const w00 = (1 - u) * inv1v;
              const w10 = u * inv1v;
              const w01 = (1 - u) * v;
              const w11 = u * v;
              const sx = x + w00 * dTLx + w10 * dTRx + w01 * dBLx + w11 * dBRx;
              const sy = y + w00 * dTLy + w10 * dTRy + w01 * dBLy + w11 * dBRy;

              const fxi = Math.floor(sx), fyi = Math.floor(sy);
              const x0 = fxi < 0 ? 0 : (fxi > wm1 ? wm1 : fxi);
              const y0 = fyi < 0 ? 0 : (fyi > hm1 ? hm1 : fyi);
              const x1 = x0 < wm1 ? x0 + 1 : wm1;
              const y1 = y0 < hm1 ? y0 + 1 : hm1;
              const fx = sx - fxi < 0 ? 0 : (sx - fxi > 1 ? 1 : sx - fxi);
              const fy = sy - fyi < 0 ? 0 : (sy - fyi > 1 ? 1 : sy - fyi);
              const ifx = 1 - fx, ify = 1 - fy;

              const i00 = (y0 * W + x0) * 4;
              const i10 = (y0 * W + x1) * 4;
              const i01 = (y1 * W + x0) * 4;
              const i11 = (y1 * W + x1) * 4;
              const di = (y * W + x) * 4;

              dd[di]     = (sd[i00]   * ifx + sd[i10]   * fx) * ify + (sd[i01]   * ifx + sd[i11]   * fx) * fy;
              dd[di + 1] = (sd[i00+1] * ifx + sd[i10+1] * fx) * ify + (sd[i01+1] * ifx + sd[i11+1] * fx) * fy;
              dd[di + 2] = (sd[i00+2] * ifx + sd[i10+2] * fx) * ify + (sd[i01+2] * ifx + sd[i11+2] * fx) * fy;
              dd[di + 3] = 255;
            }
          }
          ctx.putImageData(dstP, 0, 0);
        }

        // ── 4. Ondulación sinusoidal por filas (derrota layout espacial) ──
        // Desplaza cada fila horizontalmente una cantidad sinusoidal.
        // Frecuencia y fase aleatorias → cada imagen tiene un "fingerprint" único.
        // El ojo humano no lo detecta con ±1-2px.
        if (cfg.lineWarpMax > 0) {
          const warpAmp   = cfg.lineWarpMax;
          const warpFreq  = rnd(0.8, 2.5);     // ciclos a lo largo del alto
          const warpPhase = rnd(0, Math.PI * 2);
          const src2 = ctx.getImageData(0, 0, W, H);
          const dst2 = ctx.createImageData(W, H);

          for (let y = 0; y < H; y++) {
            const offset = Math.round(warpAmp * Math.sin(y / H * warpFreq * 2 * Math.PI + warpPhase));
            for (let x = 0; x < W; x++) {
              const srcXw = Math.min(W - 1, Math.max(0, x - offset));
              const si = (y * W + srcXw) * 4;
              const di = (y * W + x) * 4;
              dst2.data[di]     = src2.data[si];
              dst2.data[di + 1] = src2.data[si + 1];
              dst2.data[di + 2] = src2.data[si + 2];
              dst2.data[di + 3] = src2.data[si + 3];
            }
          }
          ctx.putImageData(dst2, 0, 0);
        }

        // ── 5. Manipulación pixel a pixel ─────────────────────────────────
        const imageData = ctx.getImageData(0, 0, W, H);
        const data = imageData.data;

        // Parámetros globales (aleatorios por imagen)
        const pixelNoise = cfg.pixelNoiseMax > 0 ? rndI(0, cfg.pixelNoiseMax) : 0;
        const bright     = cfg.brightMax > 0     ? rnd(-cfg.brightMax, cfg.brightMax) : 0;
        const gradAmt    = cfg.gradientMax > 0   ? rnd(-cfg.gradientMax, cfg.gradientMax) : 0;

        // Detección de fondo: muestrea las 4 esquinas. Si tienen colores parecidos,
        // ese es el fondo dominante. Píxeles dentro de bgTolerance se considerarán fondo.
        let bgR = 0, bgG = 0, bgB = 0;
        let bgActive = false;
        if (cfg.bgShiftMax > 0 && cfg.bgTolerance > 0) {
          const corners = [
            (0 * W + 0) * 4,
            (0 * W + (W - 1)) * 4,
            ((H - 1) * W + 0) * 4,
            ((H - 1) * W + (W - 1)) * 4,
          ];
          for (const ci of corners) { bgR += data[ci]; bgG += data[ci + 1]; bgB += data[ci + 2]; }
          bgR /= 4; bgG /= 4; bgB /= 4;
          // Solo activa si las 4 esquinas son similares (fondo uniforme detectado).
          let maxDist = 0;
          for (const ci of corners) {
            const dr = data[ci] - bgR, dg = data[ci + 1] - bgG, db = data[ci + 2] - bgB;
            const d = Math.sqrt(dr * dr + dg * dg + db * db);
            if (d > maxDist) maxDist = d;
          }
          bgActive = maxDist < cfg.bgTolerance * 0.6;
        }
        const bgDR = bgActive ? rndI(-cfg.bgShiftMax, cfg.bgShiftMax) : 0;
        const bgDG = bgActive ? rndI(-cfg.bgShiftMax, cfg.bgShiftMax) : 0;
        const bgDB = bgActive ? rndI(-cfg.bgShiftMax, cfg.bgShiftMax) : 0;
        const bgTol = cfg.bgTolerance;

        // Pre-genera textura baja-frecuencia (añade keypoints fake).
        const texSize = 32;
        const tex = cfg.textureAmp > 0 ? new Float32Array(texSize * texSize) : null;
        if (tex) for (let k = 0; k < tex.length; k++) tex[k] = (Math.random() - 0.5) * 2;
        const texAmp = cfg.textureAmp;

        // ── 5a. Ruido por bloques NxN independiente (multi-escala) ───────
        // La CNN procesa parches a varias escalas (distintos stride/receptive field).
        // Aplicamos dos pasadas con tamaños de bloque diferentes:
        //   Pasada 1: bloques grandes (cfg.blockSize) con offset completo
        //   Pasada 2: bloques el doble de grandes, offset a la mitad
        // → cubre más receptive fields del modelo sin aumentar el ruido visible.
        const applyBlockNoise = (bSize: number, bNoise: number) => {
          if (bNoise <= 0) return;
          const bCols = Math.ceil(W / bSize);
          const bRows = Math.ceil(H / bSize);
          const blockOffsets = new Int16Array(bRows * bCols);
          for (let k = 0; k < blockOffsets.length; k++) {
            blockOffsets[k] = rndI(-bNoise, bNoise);
          }
          for (let y = 0; y < H; y++) {
            const by = Math.floor(y / bSize);
            for (let x = 0; x < W; x++) {
              const bOff = blockOffsets[by * bCols + Math.floor(x / bSize)];
              if (bOff === 0) continue;
              const i = (y * W + x) * 4;
              data[i]   = clamp(data[i]   + bOff);
              data[i+1] = clamp(data[i+1] + bOff);
              data[i+2] = clamp(data[i+2] + bOff);
            }
          }
        };

        // Pasada 1: escala fina
        applyBlockNoise(cfg.blockSize, cfg.blockNoiseMax);
        // Pasada 2: escala gruesa (bloques 2× más grandes, offset 1 solo)
        if (cfg.blockNoiseMax >= 2) {
          applyBlockNoise(cfg.blockSize * 2, 1);
        }

        // ── 5b. BG shift + textura + ruido global + brillo + gradiente ────
        const tsm1 = texSize - 1;
        for (let y = 0; y < H; y++) {
          // Pre-calcula coords de textura para esta fila
          const ty = tex ? (y / H) * tsm1 : 0;
          const ty0 = tex ? Math.floor(ty) : 0;
          const ty1 = tex ? Math.min(tsm1, ty0 + 1) : 0;
          const tfy = tex ? ty - ty0 : 0;

          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            let r = data[i], g = data[i+1], b = data[i+2];

            // BG shift: si este pixel es similar al fondo, shifta su color.
            if (bgActive) {
              const dr = r - bgR, dg = g - bgG, db = b - bgB;
              const dist = Math.sqrt(dr * dr + dg * dg + db * db);
              if (dist < bgTol) {
                // Falloff suave: shift completo en el centro del fondo, cero en el borde.
                const w = 1 - dist / bgTol;
                r = clamp(r + bgDR * w);
                g = clamp(g + bgDG * w);
                b = clamp(b + bgDB * w);
              }
            }

            // Textura baja-frecuencia (bilinear sampling de tex pequeño → keypoints fake)
            if (tex) {
              const tx = (x / W) * tsm1;
              const tx0 = Math.floor(tx);
              const tx1 = Math.min(tsm1, tx0 + 1);
              const tfx = tx - tx0;
              const v00 = tex[ty0 * texSize + tx0], v10 = tex[ty0 * texSize + tx1];
              const v01 = tex[ty1 * texSize + tx0], v11 = tex[ty1 * texSize + tx1];
              const top = v00 * (1 - tfx) + v10 * tfx;
              const bot = v01 * (1 - tfx) + v11 * tfx;
              const tv = (top * (1 - tfy) + bot * tfy) * texAmp;
              r = clamp(r + tv); g = clamp(g + tv); b = clamp(b + tv);
            }

            // Gradiente diagonal ultra-sutil
            if (gradAmt !== 0) {
              const t  = (x / W + y / H) / 2;  // 0..1
              const gv = gradAmt * (t - 0.5);   // centrado en 0
              r = clamp(r + gv); g = clamp(g + gv); b = clamp(b + gv);
            }

            // Brillo global
            if (bright !== 0) {
              r = clamp(r + bright); g = clamp(g + bright); b = clamp(b + bright);
            }

            // Ruido per-pixel sub-visual
            if (pixelNoise > 0) {
              r = clamp(r + rndI(-pixelNoise, pixelNoise));
              g = clamp(g + rndI(-pixelNoise, pixelNoise));
              b = clamp(b + rndI(-pixelNoise, pixelNoise));
            }

            data[i] = r; data[i+1] = g; data[i+2] = b;
          }
        }

        // ── 5c. Tone curves S-shape no-lineales por canal ─────────────────
        // LUT por canal con curva: delta = sign * amp/255 * sin(π * (2x - 1)).
        // Resultado: oscurece sombras y aclara highlights (o al revés). Toca el
        // primer conv del patch embedder de CLIP que es sensible a estadísticas
        // de bajo nivel del color. Más efectivo que un tint plano.
        if (cfg.toneCurveAmp > 0) {
          const makeLUT = (amp: number, sign: number) => {
            const lut = new Uint8ClampedArray(256);
            for (let i = 0; i < 256; i++) {
              const x = i / 255;
              const delta = sign * (amp / 255) * Math.sin(Math.PI * (2 * x - 1));
              lut[i] = Math.round((x + delta) * 255);
            }
            return lut;
          };
          const ampR = rnd(cfg.toneCurveAmp * 0.5, cfg.toneCurveAmp);
          const ampG = rnd(cfg.toneCurveAmp * 0.5, cfg.toneCurveAmp);
          const ampB = rnd(cfg.toneCurveAmp * 0.5, cfg.toneCurveAmp);
          const sR = Math.random() > 0.5 ? 1 : -1;
          const sG = Math.random() > 0.5 ? 1 : -1;
          const sB = Math.random() > 0.5 ? 1 : -1;
          const lutR = makeLUT(ampR, sR);
          const lutG = makeLUT(ampG, sG);
          const lutB = makeLUT(ampB, sB);
          for (let i = 0; i < data.length; i += 4) {
            data[i]     = lutR[data[i]];
            data[i + 1] = lutG[data[i + 1]];
            data[i + 2] = lutB[data[i + 2]];
          }
        }

        ctx.putImageData(imageData, 0, 0);

        // ── 5d. Distractor semántico (overlay visible) ────────────────────
        // Añade un objeto reconocible (emoji) en una esquina. CLIP es muy
        // sensible al contenido semántico — un concepto nuevo desplaza el
        // embedding ~0.05-0.10 cosine, que es justo lo que necesitamos.
        if (cfg.distractorChance > 0 && Math.random() < cfg.distractorChance) {
          const DISTRACTORS = ['🛍️', '🏷️', '✨', '⭐', '🎁', '👋', '❤️', '🌟', '📦', '🎀'];
          const emoji = DISTRACTORS[Math.floor(Math.random() * DISTRACTORS.length)];
          const dSize = Math.floor(Math.min(W, H) * (0.13 + Math.random() * 0.06));
          const margin = dSize * 0.5;
          const cornerIdx = Math.floor(Math.random() * 4);
          const cxs = [margin + dSize/2, W - margin - dSize/2];
          const cys = [margin + dSize/2, H - margin - dSize/2];
          const cx = cxs[cornerIdx % 2];
          const cy = cys[Math.floor(cornerIdx / 2)];
          ctx.save();
          ctx.globalAlpha = 0.78 + Math.random() * 0.18;
          ctx.font = `${dSize}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          // Pequeña rotación aleatoria para que parezca natural.
          ctx.translate(cx, cy);
          ctx.rotate((Math.random() - 0.5) * 0.4);
          ctx.fillText(emoji, 0, 0);
          ctx.restore();
        }

        // ── 5e. Marco blanco VISIBLE (border, no crop) ────────────────────
        // Si frameVPct o frameHPct > 0, envuelve la imagen procesada en un canvas
        // mayor con padding blanco. A diferencia del crop simétrico, esto SE VE.
        let outCanvas: HTMLCanvasElement = canvas;
        const fvPct = (cfg.frameVPct ?? 0) / 100;
        const fhPct = (cfg.frameHPct ?? 0) / 100;
        if (fvPct > 0 || fhPct > 0) {
          const padV = Math.round(H * fvPct);
          const padH = Math.round(W * fhPct);
          const bigW = W + padH * 2;
          const bigH = H + padV * 2;
          const big = document.createElement('canvas');
          big.width = bigW;
          big.height = bigH;
          const bctx = big.getContext('2d')!;
          bctx.fillStyle = '#ffffff';
          bctx.fillRect(0, 0, bigW, bigH);
          bctx.drawImage(canvas, padH, padV);
          outCanvas = big;
        }

        // ── 6. JPEG con calidad variable ──────────────────────────────────
        // Cuantización diferente → artefactos de compresión únicos.
        const quality = rnd(cfg.qualityMin, cfg.qualityMax);
        let dataUrl = outCanvas.toDataURL('image/jpeg', quality);

        // ── 7. EXIF aleatorio realista (si está activo) ──────────────────
        // Inyecta metadata creíble (cámara, fecha, ISO, focal…) para que la
        // foto parezca tomada con móvil. La librería se carga lazy via CDN.
        if (cfg.randomExif) {
          try {
            const { injectRandomExif } = await import('../lib/randomExif');
            dataUrl = await injectRandomExif(dataUrl);
          } catch (e) {
            console.warn('[uniquify] EXIF injection skipped:', e);
          }
        }

        const size = Math.round((dataUrl.split(',')[1].length * 3) / 4);

        resolve({
          dataUrl,
          noiseLevel: Math.max(pixelNoise, cfg.blockNoiseMax),
          dimChange: `${IW}×${IH} → ${W}×${H}`,
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

// ─── Helpers UI ───────────────────────────────────────────────────────────────

function formatSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function dl(dataUrl: string, name: string) {
  // Convertir data URL grande a Blob URL — más fiable en Chrome para JPEGs pesados.
  let href = dataUrl;
  let revoke: string | null = null;
  try {
    if (dataUrl.startsWith('data:')) {
      const [meta, b64] = dataUrl.split(',');
      const mime = meta.match(/:(.*?);/)?.[1] || 'image/jpeg';
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const blob = new Blob([buf], { type: mime });
      href = URL.createObjectURL(blob);
      revoke = href;
    }
  } catch { /* fallback al data url */ }
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (revoke) setTimeout(() => URL.revokeObjectURL(revoke!), 1000);
}

async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const res  = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], name, { type: 'image/jpeg' });
}

function canShareFiles(): boolean {
  try {
    return (
      typeof navigator.share === 'function' &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [new File([''], 'test.jpg', { type: 'image/jpeg' })] })
    );
  } catch {
    return false;
  }
}

const IS_MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

async function saveOne(dataUrl: string, filename: string): Promise<void> {
  // Siempre forzamos descarga vía <a download>. navigator.share daba problemas
  // silenciosos cuando el usuario cerraba el sheet o el navegador lo bloqueaba.
  dl(dataUrl, filename);
}

async function saveAll(
  items: { dataUrl: string; filename: string }[],
  onProgress?: (n: number) => void
): Promise<void> {
  items.forEach((item, idx) => {
    setTimeout(() => {
      dl(item.dataUrl, item.filename);
      onProgress?.(idx + 1);
    }, idx * 200);
  });
}

// ─── Repost configs (multi-modificación cíclica) ──────────────────────────────
// Cada fila de la tabla "Configuración de repost" es una RepostConfig.
// processFiles aplica configs[i % configs.length] a cada foto subida.

interface RepostConfig extends ModeConfig {
  rid: string;                              // id único de la fila
  editTitle: 'auto' | 'manual';
  editDescription: 'auto' | 'manual';
}

// Base común — configuración FUERTE anti-detección.
// Cada técnica rompe una capa diferente del sistema de deduplicación de Vinted:
//   crop 1.5-3.5%  → pHash distancia Hamming máxima (derrota paso 1)
//   blockNoise ±4 en bloques 16px → cada parche del embedder CNN ve estadísticas distintas (derrota paso 2)
//   lineWarp ±1px  → layout espacial único por imagen
//   perspectiveMax 4px → coordenadas de keypoints SIFT/ORB cambian (derrota paso 3)
//   randomExif     → EXIF de iPhone/Samsung realista, foto parece tomada con móvil
const REPOST_BASE: Omit<ModeConfig, 'id' | 'label' | 'desc'> = {
  trimMin: 2, trimMax: 4,
  cropPctMin: 1.5, cropPctMax: 3.5,   // ↑ crop más agresivo → rompe pHash con margen
  pixelNoiseMax: 2,
  blockNoiseMax: 4, blockSize: 16,     // ↑ bloques más pequeños y más ruido → rompe embedding CNN
  lineWarpMax: 1,                       // ↑ ondulación sinusoidal por filas → layout espacial único
  brightMax: 3,
  gradientMax: 2,                       // gradiente diagonal sutil
  rotateDegMax: 0,
  qualityMin: 0.87, qualityMax: 0.93,  // ↑ más variación de artefactos JPEG
  flipChance: 0,
  aspectStretchMax: 0.01,               // stretch mínimo de proporción
  perspectiveMax: 4,                    // ↑ warp de perspectiva → rompe SIFT/ORB
  bgShiftMax: 0,
  bgTolerance: 0,
  textureAmp: 0,
  offCenterKeepMin: 0,
  offCenterKeepMax: 0,
  toneCurveAmp: 0,
  distractorChance: 0,
  randomExif: true,                     // ↑ EXIF realista de móvil en cada foto
};

let RID_SEQ = 0;
const nextRid = () => `rc-${Date.now()}-${++RID_SEQ}`;

function makeConfig(partial: Partial<ModeConfig> & Pick<ModeConfig, 'id' | 'label' | 'desc'>): RepostConfig {
  return {
    ...REPOST_BASE,
    ...partial,
    rid: nextRid(),
    editTitle: 'auto',
    editDescription: 'auto',
  } as RepostConfig;
}

// Presets — sin marcos, sin rotación, sin skew. Solo técnicas 100% invisibles.
// Cada imagen aplica además randomizeTransform() → flip y perspectiva únicos por foto.
const DEFAULT_CONFIGS: RepostConfig[] = [
  makeConfig({ id: 'normal', label: '#1', desc: 'Crop + ruido',            frameVPct: 0, frameHPct: 0 }),
  makeConfig({ id: 'normal', label: '#2', desc: 'Crop + ruido + flip',     frameVPct: 0, frameHPct: 0, flipChance: 0.5 }),
  makeConfig({ id: 'normal', label: '#3', desc: 'Perspectiva media',       frameVPct: 0, frameHPct: 0, perspectiveMax: 5 }),
  makeConfig({ id: 'normal', label: '#4', desc: 'Perspectiva media + flip',frameVPct: 0, frameHPct: 0, flipChance: 0.5, perspectiveMax: 5 }),
  makeConfig({ id: 'normal', label: '#5', desc: 'Perspectiva fuerte',      frameVPct: 0, frameHPct: 0, perspectiveMax: 9 }),
  makeConfig({ id: 'normal', label: '#6', desc: 'Perspectiva fuerte + flip',frameVPct: 0, frameHPct: 0, flipChance: 0.5, perspectiveMax: 9 }),
  makeConfig({ id: 'normal', label: '#7', desc: 'Crop extra',              frameVPct: 0, frameHPct: 0, cropPctMin: 2.5, cropPctMax: 4 }),
  makeConfig({ id: 'normal', label: '#8', desc: 'Crop extra + flip',       frameVPct: 0, frameHPct: 0, flipChance: 0.5, cropPctMin: 2.5, cropPctMax: 4 }),
];

// ─── Parámetros de transformación únicos por foto ────────────────────────────
// Genera parámetros INVISIBLES completamente aleatorios por imagen.
// Con 50 personas o la misma persona subiendo la misma foto varias veces,
// cada resultado es irrepetible. Solo usa técnicas que NO crean bordes visibles:
//   · flip horizontal (espejo total — cubre el canvas completo, sin bordes)
//   · perspective warp (desplaza esquinas ±px — clamping al borde, sin bordes)
// La rotación y el skew están EXCLUIDOS: crean marcos negros en fotos portrait/landscape
// porque la fórmula de escala depende del aspect ratio y la foto queda visible.
function randomizeTransform(): Pick<ModeConfig, 'flipChance' | 'perspectiveMax'> {
  const rnd = (a: number, b: number) => +(a + Math.random() * (b - a)).toFixed(2);
  const coin = (p: number) => Math.random() < p;
  return {
    flipChance:     coin(0.45) ? 0.5 : 0,
    perspectiveMax: rnd(3, 10),
  };
}

function summarizeConfig(c: RepostConfig): string {
  const parts: string[] = [];
  if (c.skewX || c.skewY) parts.push(`Sesgar X: ${c.skewX ?? 0}  Y: ${c.skewY ?? 0}`);
  if (c.rotateDegMax) parts.push(`Rotar ±${c.rotateDegMax}°`);
  const fv = c.frameVPct ?? 0, fh = c.frameHPct ?? 0;
  if (fv === fh && fv > 0) parts.push(`Marco ${fv}%`);
  else if (fv || fh) parts.push(`Marco V:${fv}% H:${fh}%`);
  if (c.flipChance > 0) parts.push('Flip 50%');
  // Siempre muestra el crop invisible
  parts.push(`Crop invisible + ruido ±${c.blockNoiseMax}`);
  return parts.join(' · ');
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProcessedImage {
  id: string; originalName: string; originalUrl: string;
  processedUrl: string | null; originalSize: number; processedSize: number;
  status: 'processing' | 'done' | 'error'; noiseLevel: number; dimChange: string; mode: Mode;
  hashShort?: string;          // SHA-1 corto de la procesada (prueba visual de unicidad)
  originalHashShort?: string;  // SHA-1 corto de la original
}

async function sha1Short(input: string | ArrayBuffer): Promise<string> {
  const buf = typeof input === 'string'
    ? new TextEncoder().encode(input)
    : new Uint8Array(input);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 10);
}

// ─── Sub-componente: campo numérico para el editor ───────────────────────────

function NumField({
  label, value, onChange, step = 1, min, max,
}: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; max?: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-white/40">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={e => {
          const v = parseFloat(e.target.value);
          onChange(Number.isFinite(v) ? v : 0);
        }}
        className="bg-black border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/90 focus:border-acid focus:outline-none"
      />
    </label>
  );
}

// ─── Componente ───────────────────────────────────────────────────────────────

export default function ImageUniquifier() {
  const [configs, setConfigs]       = useState<RepostConfig[]>(DEFAULT_CONFIGS);
  const [expandedRid, setExpandedRid] = useState<string | null>(null);
  const [images, setImages]         = useState<ProcessedImage[]>([]);
  const [dragging, setDragging]     = useState(false);
  const [savingAll, setSavingAll]   = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [configsOpen, setConfigsOpen]   = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateConfig = (rid: string, patch: Partial<RepostConfig>) => {
    setConfigs(prev => prev.map(c => c.rid === rid ? { ...c, ...patch } : c));
  };
  const removeConfig = (rid: string) => {
    setConfigs(prev => prev.length <= 1 ? prev : prev.filter(c => c.rid !== rid));
  };
  const addConfig = () => {
    setConfigs(prev => [
      ...prev,
      makeConfig({ id: 'normal', label: `#${prev.length + 1}`, desc: 'Nueva configuración', frameVPct: 0, frameHPct: 0 }),
    ]);
  };
  const resetConfigs = () => {
    setConfigs(DEFAULT_CONFIGS.map(c => ({ ...c, rid: nextRid() })));
    setImages([]);
  };
  // Aleatorio: perturba los valores numéricos de cada config para que el lote sea
  // diferente sin perder la idea (sesgar, rotar, marco). El número de filas no cambia.
  const randomizeConfigs = () => {
    setConfigs(prev => prev.map((c, i) => ({
      ...c,
      skewX:        0,
      skewY:        0,
      rotateDegMax: 0,
      flipChance:   i % 2 === 1 ? 0.5 : 0,   // pares sin flip, impares con flip
      perspectiveMax: 3 + Math.random() * 7,  // 3-10 px, siempre diferente
      frameVPct:    0,
      frameHPct:    0,
    })));
  };

  const processFiles = useCallback(async (files: FileList | File[], cfgs: RepostConfig[]) => {
    // Acepta cualquier archivo cuyo type sea image/* o cuya extensión parezca imagen.
    // iOS/Android a veces devuelven HEIC/HEIF con type vacío.
    const looksLikeImage = (f: File) =>
      f.type.startsWith('image/') ||
      /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(f.name);
    const all = Array.from(files);
    const arr = all.filter(looksLikeImage);
    if (!cfgs.length) { console.warn('[uniquify] sin configs'); return; }
    if (!arr.length) {
      console.warn('[uniquify] ningún archivo pasa el filtro de imagen:', all.map(f => `${f.name} (${f.type || 'sin type'})`));
      alert('No se reconoció ningún archivo como imagen. Asegúrate de subir JPG, PNG, WEBP o HEIC.');
      return;
    }
    const entries: ProcessedImage[] = arr.map((f, i) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}-${i}`,
      originalName: f.name, originalUrl: URL.createObjectURL(f),
      processedUrl: null, originalSize: f.size, processedSize: 0,
      status: 'processing', noiseLevel: 0, dimChange: '',
      mode: cfgs[i % cfgs.length].id,
    }));
    setImages(prev => [...entries, ...prev]);

    for (let i = 0; i < arr.length; i++) {
      const entry = entries[i];
      // Mezcla el config cíclico (para editTitle/editDescription) con parámetros
      // geométricos completamente nuevos por imagen → cada proceso es irrepetible,
      // aunque 50 personas suban la misma foto o la misma persona la suba 5 veces.
      const mc: RepostConfig = { ...cfgs[i % cfgs.length], ...randomizeTransform() };
      try {
        const origBuf = await arr[i].arrayBuffer();
        const origHash = await sha1Short(origBuf);
        setImages(prev => prev.map(img => img.id === entry.id ? { ...img, originalHashShort: origHash } : img));
        const res = await uniquifyImage(arr[i], mc);
        const procHash = await sha1Short(res.dataUrl);
        setImages(prev => prev.map(img =>
          img.id === entry.id
            ? { ...img, processedUrl: res.dataUrl, processedSize: res.size, status: 'done', noiseLevel: res.noiseLevel, dimChange: res.dimChange, hashShort: procHash }
            : img
        ));
      } catch (e) {
        console.error('[uniquify] error', e);
        setImages(prev => prev.map(img => img.id === entry.id ? { ...img, status: 'error' } : img));
      }
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false); processFiles(e.dataTransfer.files, configs);
  }, [processFiles, configs]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(e.target.files, configs);
    e.target.value = '';
  };

  const reprocess = async (id: string) => {
    const entry = images.find(img => img.id === id); if (!entry) return;
    // Regenera con la primera config disponible (los presets cíclicos solo importan en lote).
    const mc = configs[0];
    if (!mc) return;
    setImages(prev => prev.map(img => img.id === id ? { ...img, status: 'processing', processedUrl: null } : img));
    try {
      const blob = await fetch(entry.originalUrl).then(r => r.blob());
      const file = new File([blob], entry.originalName, { type: 'image/jpeg' });
      const res  = await uniquifyImage(file, mc);
      setImages(prev => prev.map(img =>
        img.id === id
          ? { ...img, processedUrl: res.dataUrl, processedSize: res.size, status: 'done', noiseLevel: res.noiseLevel, dimChange: res.dimChange }
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
    saveOne(dataUrl, originalName.replace(/\.[^.]+$/, '_unique.jpg'));
  };

  const remove    = (id: string) => setImages(prev => prev.filter(i => i.id !== id));
  const clearAll  = () => setImages([]);
  const doneCount = images.filter(i => i.status === 'done').length;

  const saveLabel    = IS_MOBILE ? 'Guardar' : 'Descargar';
  const saveAllLabel = IS_MOBILE ? 'Guardar en galería' : 'Descargar todas';

  return (
    <div className="space-y-6">

      {/* Drop Zone — arriba del todo */}
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
          <div className={`w-16 h-16 rounded-2xl flex items-center justify-center border transition-all ${dragging ? 'bg-acid-soft border-acid' : 'bg-white/5 border-white/10'}`}>
            <Upload className={`w-7 h-7 ${dragging ? 'text-acid' : 'text-white/40'}`} />
          </div>
          <div>
            <p className="text-white font-semibold">Arrastra las fotos del producto aquí · o haz click</p>
            <p className="text-white/40 text-sm mt-1">Cada foto se procesa con la configuración cíclica de abajo</p>
          </div>
        </div>
      </div>

      {/* Configuración de repost — tabla cíclica */}
      <div className="bg-[#0f0f0f] border border-white/[0.08] rounded-2xl overflow-hidden">
        <div
          className={`p-5 flex items-center justify-between cursor-pointer select-none ${configsOpen ? 'pb-3 border-b border-white/5' : 'pb-5'}`}
          onClick={() => setConfigsOpen(v => !v)}
        >
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-white/50">Configuración de modificaciones</p>
            <p className="text-[11px] text-white/40 mt-1">Define varios sets — cada foto subida usa uno en orden cíclico</p>
          </div>
          {configsOpen
            ? <ChevronUp className="w-4 h-4 text-white/30 shrink-0" />
            : <ChevronDown className="w-4 h-4 text-white/30 shrink-0" />}
        </div>

        {configsOpen && (<>
        {/* Header */}
        <div className="hidden md:grid grid-cols-[40px_1fr_140px_140px_180px] gap-3 px-5 py-3 text-[10px] uppercase tracking-widest text-white/40 font-bold border-b border-white/5">
          <div>#</div>
          <div>Modificaciones</div>
          <div>Editar título</div>
          <div>Editar descripción</div>
          <div>Acciones</div>
        </div>

        {/* Filas */}
        <div className="divide-y divide-white/5">
          {configs.map((c, idx) => {
            const expanded = expandedRid === c.rid;
            return (
              <div key={c.rid}>
                <div className="grid grid-cols-1 md:grid-cols-[40px_1fr_140px_140px_180px] gap-3 px-5 py-4 items-center">
                  <div className="text-white/40 font-mono text-sm">{idx + 1}</div>

                  <div className="text-[12px] text-white/80 leading-snug">
                    {summarizeConfig(c)}
                  </div>

                  <select
                    value={c.editTitle}
                    onChange={e => updateConfig(c.rid, { editTitle: e.target.value as 'auto' | 'manual' })}
                    className="bg-black border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/80 focus:border-acid focus:outline-none"
                  >
                    <option value="auto">✦ Auto</option>
                    <option value="manual">✎ Manual</option>
                  </select>

                  <select
                    value={c.editDescription}
                    onChange={e => updateConfig(c.rid, { editDescription: e.target.value as 'auto' | 'manual' })}
                    className="bg-black border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/80 focus:border-acid focus:outline-none"
                  >
                    <option value="auto">✦ Auto</option>
                    <option value="manual">✎ Manual</option>
                  </select>

                  <div className="flex gap-2">
                    <button
                      onClick={() => setExpandedRid(expanded ? null : c.rid)}
                      className="flex items-center gap-1.5 bg-acid-soft border border-acid/40 text-acid hover:bg-acid hover:text-black font-bold px-3 py-1.5 rounded-lg text-xs transition"
                    >
                      {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
                      Abrir editor
                    </button>
                    <button
                      onClick={() => removeConfig(c.rid)}
                      disabled={configs.length <= 1}
                      className="flex items-center gap-1.5 bg-pink-500/20 border border-pink-400/30 text-pink-300 hover:bg-pink-500/40 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed font-bold px-3 py-1.5 rounded-lg text-xs transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Eliminar
                    </button>
                  </div>
                </div>

                {/* Editor expandido inline */}
                {expanded && (
                  <div className="px-5 pb-5 pt-1 bg-black/30">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                      <NumField label="Sesgar X" step={0.1} value={c.skewX ?? 0} onChange={v => updateConfig(c.rid, { skewX: v })} />
                      <NumField label="Sesgar Y" step={0.1} value={c.skewY ?? 0} onChange={v => updateConfig(c.rid, { skewY: v })} />
                      <NumField label="Rotar máx (°)" step={0.5} min={0} value={c.rotateDegMax} onChange={v => updateConfig(c.rid, { rotateDegMax: v })} />
                      <NumField label="Marco vertical (%)" step={0.1} min={0} max={50} value={c.frameVPct ?? 0} onChange={v => updateConfig(c.rid, { frameVPct: v })} />
                      <NumField label="Marco horizontal (%)" step={0.1} min={0} max={50} value={c.frameHPct ?? 0} onChange={v => updateConfig(c.rid, { frameHPct: v })} />
                      <NumField label="Ruido por bloque" step={1} min={0} max={6} value={c.blockNoiseMax} onChange={v => updateConfig(c.rid, { blockNoiseMax: v })} />
                      <NumField label="Brillo máx" step={1} min={0} max={20} value={c.brightMax} onChange={v => updateConfig(c.rid, { brightMax: v })} />
                      <NumField label="JPEG calidad mín" step={0.01} min={0.5} max={1} value={c.qualityMin} onChange={v => updateConfig(c.rid, { qualityMin: v })} />
                      <NumField label="JPEG calidad máx" step={0.01} min={0.5} max={1} value={c.qualityMax} onChange={v => updateConfig(c.rid, { qualityMax: v })} />
                      <NumField label="Flip horizontal (0-1)" step={0.1} min={0} max={1} value={c.flipChance} onChange={v => updateConfig(c.rid, { flipChance: v })} />
                      <label className="flex items-center gap-2 text-xs text-white/70 col-span-2 md:col-span-1">
                        <input
                          type="checkbox"
                          checked={c.randomExif}
                          onChange={e => updateConfig(c.rid, { randomExif: e.target.checked })}
                          className="accent-acid"
                        />
                        EXIF aleatorio
                      </label>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer tabla */}
        <div className="px-5 py-4 border-t border-white/5">
          <button
            onClick={addConfig}
            className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 hover:text-white font-bold px-4 py-2 rounded-xl text-xs transition"
          >
            <Plus className="w-4 h-4" />
            Agregar configuración
          </button>
          <p className="text-[11px] text-white/40 mt-3">
            Cada foto que subas usa una configuración. Al llegar a la última, vuelve a la primera.
          </p>
          <p className="text-[11px] text-acid mt-1">
            Rotación activa: orden 1, 2, 3… y vuelve a 1.
          </p>
        </div>
        </>)}
      </div>

      {configsOpen && (
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={randomizeConfigs}
          className="flex items-center gap-2 bg-acid hover:bg-acid/90 text-black font-bold px-5 py-2.5 rounded-xl text-sm transition"
        >
          <Shuffle className="w-4 h-4" />
          Aleatorio
        </button>
        <button
          onClick={resetConfigs}
          className="flex items-center gap-2 bg-pink-500/20 hover:bg-pink-500/40 border border-pink-400/30 text-pink-200 hover:text-white font-bold px-5 py-2.5 rounded-xl text-sm transition"
        >
          <RotateCcw className="w-4 h-4" />
          Resetear formulario
        </button>
      </div>
      )}

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
          {images.map(img => {
            const mc = MODES.find(m => m.id === img.mode) ?? MODES[1];
            return (
              <motion.div key={img.id}
                initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9 }}
                className="bg-[#141414] border border-white/5 rounded-2xl overflow-hidden">
                <div className="relative aspect-square bg-black/40 flex items-center justify-center overflow-hidden">
                  {img.processedUrl
                    ? <img src={img.processedUrl} alt={img.originalName} className="w-full h-full object-contain bg-black/60" />
                    : img.status === 'processing'
                    ? <div className="flex flex-col items-center gap-3"><RefreshCcw className="w-8 h-8 animate-spin text-acid" /><span className="text-xs text-white/30">Procesando…</span></div>
                    : img.status === 'error'
                    ? <div className="flex flex-col items-center gap-2 text-red-400/60"><ZapOff className="w-8 h-8" /><span className="text-xs">Error</span></div>
                    : <ImageIcon className="w-12 h-12 text-white/10" />
                  }
                  {img.status === 'done' && (
                    <div className="absolute top-2 right-2 bg-acid rounded-full p-1">
                      <CheckCircle2 className="w-3.5 h-3.5 text-black" />
                    </div>
                  )}
                  <div className={`absolute top-2 left-2 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider ${
                    img.mode === 'extremo' ? 'bg-red-950 text-red-400 border border-red-800' : 'bg-white/10 text-white/60 border border-white/10'
                  }`}>
                    {mc.label}
                  </div>
                </div>
                <div className="p-4 space-y-3">
                  <p className="text-xs text-white/70 truncate font-medium">{img.originalName}</p>
                  {img.status === 'done' && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] text-white/30"><span>Original</span><span className="font-mono">{formatSize(img.originalSize)}</span></div>
                      <div className="flex justify-between text-[10px] text-acid"><span>Procesada</span><span className="font-mono">{formatSize(img.processedSize)}</span></div>
                      <div className="text-[10px] text-white/20 font-mono mt-1">{img.dimChange}</div>
                      <div className="text-[10px] text-white/20 font-mono">Bloques ±{img.noiseLevel} · Sin EXIF</div>
                      {img.originalHashShort && img.hashShort && (
                        <div className="mt-2 pt-2 border-t border-white/5 space-y-0.5">
                          <div className="flex justify-between text-[10px] text-white/30 font-mono"><span>Hash original</span><span>{img.originalHashShort}</span></div>
                          <div className="flex justify-between text-[10px] text-acid font-mono"><span>Hash nuevo ✓</span><span>{img.hashShort}</span></div>
                        </div>
                      )}
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
            );
          })}
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
