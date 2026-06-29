// Shared Gemini/AI helpers — importados tanto por server.ts como por el worker de BullMQ

export function jpegDimsFromBase64(b64: string): { w: number; h: number } | null {
  try {
    const clean = b64.includes(",") ? b64.split(",")[1] : b64;
    const buf = Buffer.from(clean, "base64");
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let off = 2;
    while (off < buf.length - 8) {
      if (buf[off] !== 0xff) return null;
      const marker = buf[off + 1];
      // SOF0=0xC0, SOF1=0xC1, SOF2=0xC2 (los más comunes). Saltamos DHT/JPG/DAC/RST.
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        const h = buf.readUInt16BE(off + 5);
        const w = buf.readUInt16BE(off + 7);
        return { w, h };
      }
      const segLen = buf.readUInt16BE(off + 2);
      off += 2 + segLen;
    }
    return null;
  } catch { return null; }
}

// Lista EXACTA de aspect ratios aceptados por la API de Gemini (imageConfig.aspect_ratio):
// '1:1','1:4','1:8','2:3','3:2','3:4','4:1','4:3','4:5','5:4','8:1','9:16','16:9','21:9'
export function pickGeminiAspect(w: number, h: number): string {
  const ratios: { label: string; v: number }[] = [
    { label: "8:1",  v: 8 / 1  },
    { label: "4:1",  v: 4 / 1  },
    { label: "21:9", v: 21 / 9 },
    { label: "16:9", v: 16 / 9 },
    { label: "5:4",  v: 5 / 4  },
    { label: "4:3",  v: 4 / 3  },
    { label: "3:2",  v: 3 / 2  },
    { label: "1:1",  v: 1      },
    { label: "4:5",  v: 4 / 5  },
    { label: "3:4",  v: 3 / 4  },
    { label: "2:3",  v: 2 / 3  },
    { label: "9:16", v: 9 / 16 },
    { label: "1:4",  v: 1 / 4  },
    { label: "1:8",  v: 1 / 8  },
    // ELIMINADO: "9:21" — NO está en la lista aceptada → causaba HTTP 400
  ];
  const target = w / h;
  let best = ratios[0];
  let bestDiff = Math.abs(Math.log(target / best.v));
  for (const r of ratios) {
    const d = Math.abs(Math.log(target / r.v));
    if (d < bestDiff) { bestDiff = d; best = r; }
  }
  return best.label;
}

export function buildTonguePreamble(hasReference: boolean): string {
  if (hasReference) {
    return (
      `Tienes DOS imágenes adjuntas: ` +
      `IMAGE 1 (primera imagen) es una etiqueta de lengüeta AUTÉNTICA de referencia — ` +
      `estudia su estilo visual exacto: tipografía, peso de fuente, espaciado, ` +
      `textura de impresión por transferencia térmica y calidad de tejido. ` +
      `IMAGE 2 (segunda imagen) es la foto real de la etiqueta que debes editar. ` +
      `REGLA CRÍTICA: los valores que aparecen en las instrucciones de SUSTITUCIÓN a continuación ` +
      `son los CORRECTOS y tienen PRIORIDAD ABSOLUTA sobre lo que veas en IMAGE 2. ` +
      `Si IMAGE 2 muestra un valor diferente al indicado, IGNORA lo de IMAGE 2 y usa el valor de las instrucciones. ` +
      `INTEGRACIÓN DE TEXTURA FÍSICA: los textos nuevos en IMAGE 2 deben integrarse visualmente ` +
      `con el sustrato real del tejido — adoptando exactamente la perspectiva y ángulo de la cámara, ` +
      `siguiendo las microarrugas, curvas y pliegues de la lengüeta, ` +
      `con el mismo micro-grano de impresión por transferencia térmica, idéntica opacidad ` +
      `y las mismas reflexiones de luz rasante que el texto ya existente. ` +
      `Ningún texto sustituto debe parecer superpuesto digitalmente ni más nítido que el tejido. ` +
      `Ahora aplica las siguientes instrucciones en alta precisión a IMAGE 2:`
    );
  }
  return (
    `Te adjunto la imagen de la etiqueta/lengueta. ` +
    `REGLA CRÍTICA: los valores que aparecen en las instrucciones de SUSTITUCIÓN a continuación ` +
    `son los CORRECTOS y tienen PRIORIDAD ABSOLUTA sobre lo que veas en la imagen. ` +
    `Si la imagen muestra un valor diferente al indicado, IGNORA lo de la imagen y usa el valor de las instrucciones. ` +
    `INTEGRACIÓN DE TEXTURA FÍSICA: los textos nuevos deben integrarse visualmente con el sustrato real del tejido — ` +
    `adoptando exactamente la perspectiva y ángulo de la cámara, siguiendo las microarrugas, curvas y pliegues de la lengüeta, ` +
    `con el mismo micro-grano de impresión por transferencia térmica, idéntica opacidad y las mismas reflexiones de luz rasante ` +
    `que el texto ya existente en la etiqueta. ` +
    `Ningún texto sustituto debe parecer superpuesto digitalmente ni más nítido que el tejido: ` +
    `toda la tipografía debe verse imprimida en la misma pasada de fábrica, con coherencia de perspectiva 3D ` +
    `y micro-deformación acorde a los pliegues visibles del tejido. ` +
    `Ahora aplica las siguientes instrucciones en alta precisión:`
  );
}

export function buildTonguePrompt(brand: string, d: any, customPrompt: string, hasReference = false): string {
  const sizes = d.sizes || {};
  const TONGUE_PREAMBLE = buildTonguePreamble(hasReference);
  // El customPrompt va DESPUÉS del preámbulo pero ANTES de los valores específicos,
  // para que sus reglas de calidad/estilo sean el contexto que rige todo lo que sigue.
  const CUSTOM_BLOCK = customPrompt
    ? `\nREGLAS ADICIONALES DE CALIDAD (aplican a toda la generación):\n${customPrompt}\n`
    : "";
  if (brand === "ADIDAS") {
    return [
      TONGUE_PREAMBLE,
      CUSTOM_BLOCK,
      `Edita la etiqueta interior de la lengüeta de la zapatilla adidas que ves en la foto.`,
      `Mantén EXACTAMENTE la misma foto en todo: encuadre, fondo, iluminación, ángulo, grano, perspectiva, textura del tejido, costuras, sombras, doblez de la lengüeta. No reencuadres, no añadas elementos nuevos.`,
      ``,
      `Conserva sin tocar los siguientes textos exactamente como aparecen ahora:`,
      `  · ART NO / SKU "${d.sku}"`,
      `  · FACTORY / LVL "${d.lvl}"`,
      `  · Tabla de tallas: US ${sizes.us}  UK ${sizes.uk}  FR ${sizes.fr}  JP ${sizes.jp}`,
      ``,
      `SUSTITUYE únicamente estos textos por los nuevos valores indicados (usa EXACTAMENTE estos valores, no los de la imagen):`,
      `  · FECHA: borra la fecha que aparece en la imagen y escribe "${d.date}" en su lugar`,
      `  · Brand Serial de abajo a la izquierda → "${d.brandSerial}"`,
      `  · Reference (la que empieza por #) → "${d.reference}"`,
      ``,
      `Usa la misma tipografía sans-serif bold de adidas, mismo tamaño y posición que el texto que sustituyes. Mantén el aspecto de foto cruda con cámara de móvil 12 MP — sin marcas de agua, sin texto adicional, sin firma, sin logo nuevo.`,
    ].filter(Boolean).join("\n");
  }
  if (brand === "ASICS") {
    return [
      TONGUE_PREAMBLE,
      CUSTOM_BLOCK,
      `Edita la etiqueta interior de la lengüeta ASICS que ves en la foto.`,
      `Mantén EXACTAMENTE la misma foto en todo: encuadre, fondo, ángulo, perspectiva, iluminación, grano, costuras y textura del tejido. No reencuadres ni añadas elementos.`,
      ``,
      `Preserva tal cual:`,
      `  · SKU "${d.sku}"`,
      `  · Tabla de tallas con los separadores verticales | : US ${sizes.us} | UK ${sizes.uk} | FR ${sizes.fr} | JP ${sizes.jp}`,
      ``,
      `SUSTITUYE solo (usa EXACTAMENTE estos valores, no los de la imagen):`,
      `  · Fecha: borra la fecha que aparece en la imagen y escribe "${d.date}" en su lugar`,
      `  · Tracking code (1 letra + 6 dígitos) → "${d.reference}"`,
      `  · Serial number (15 alfanuméricos en mayúsculas) → "${d.brandSerial}"`,
      ``,
      `Usa la tipografía compacta y limpia característica de ASICS, mismo tamaño y posición que los textos sustituidos. Estilo de foto macro de móvil, sin marcas de agua ni texto extra.`,
    ].filter(Boolean).join("\n");
  }
  if (brand === "ONITSUKA") {
    return [
      TONGUE_PREAMBLE,
      CUSTOM_BLOCK,
      `Edita la etiqueta interior de la lengüeta ONITSUKA TIGER que ves en la foto.`,
      `Mantén EXACTAMENTE la misma foto: mismo encuadre, fondo, ángulo, iluminación, grano, costuras y textura. No reencuadres ni añadas elementos.`,
      ``,
      `Preserva tal cual:`,
      `  · SKU "${d.sku}"`,
      `  · Tabla de tallas: US ${sizes.us}  UK ${sizes.uk}  FR ${sizes.fr}  CM ${sizes.jp}`,
      `  · Texto país "MADE IN INDONESIA / FABRIQUE EN INDONESIE"`,
      ``,
      `SUSTITUYE solo (usa EXACTAMENTE estos valores, no los de la imagen):`,
      `  · Fecha: borra la fecha que aparece en la imagen y escribe "${d.date}" en su lugar`,
      `  · Batch Code (formato F + 6 dígitos) → "${d.reference}"`,
      `  · Unit Serial (15 alfanuméricos en mayúsculas) → "${d.brandSerial}"`,
      ``,
      `Tipografía sans-serif ultra-condensada, fondo blanco mate, impresión transfer térmico. Sin logo de tigre, sin marcas de agua, etiqueta puramente informativa.`,
    ].filter(Boolean).join("\n");
  }
  // NEW BALANCE (default)
  return [
    TONGUE_PREAMBLE,
    CUSTOM_BLOCK,
    `Edita la etiqueta interior de la lengüeta NEW BALANCE que ves en la foto.`,
    `Mantén EXACTAMENTE la misma foto: mismo encuadre, fondo, ángulo, iluminación, grano, costuras y textura del tejido satinado. No reencuadres ni añadas elementos nuevos.`,
    ``,
    `Preserva tal cual:`,
    `  · Style / Model "${d.sku}"`,
    `  · Factory "${d.lvl}"`,
    `  · Tabla de tallas: US ${sizes.us}  UK ${sizes.uk}  EU ${sizes.fr}  CM ${sizes.jp}`,
    ``,
    `SUSTITUYE exactamente estos códigos (usa EXACTAMENTE estos valores, no los de la imagen):`,
    `  · Fecha: borra la fecha que aparece en la imagen y escribe "${d.date}" en su lugar`,
    `  · Serial 1 (12 dígitos) → "${d.reference}"`,
    `  · Serial 2 (7 dígitos) → "${d.reference2}"`,
    `  · Brand code → "${d.brandSerial}"`,
    ``,
    `Tipografía industrial pesada idéntica a la original, mismas posiciones, foto macro de móvil. Sin marcas de agua, sin firma, sin texto extra.`,
  ].filter(Boolean).join("\n");
}
