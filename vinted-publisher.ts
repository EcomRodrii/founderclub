/**
 * VintedPublisher — Puppeteer-based Vinted form automation.
 * Uses stored session cookies to publish listings server-side.
 */

import puppeteer, { type Browser, type Page, type CookieParam } from "puppeteer";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VintedListingPayload {
  title: string;
  description?: string;
  price: number;
  condition: "neuf_etiquette" | "neuf_sans_etiquette" | "tres_bon" | "bon" | "acceptable";
  brand: string;
  size?: string;
  gender: "men" | "women";
  images: string[]; // data:image/...;base64,... or https://...
  packageSize: "small" | "medium" | "large";
  domain: string; // 'es', 'fr', 'it', etc.
}

export interface PublishEvent {
  type: "log" | "error" | "done";
  step: string;
  message: string;
  screenshot?: string;
}

export type ProgressFn = (event: PublishEvent) => void;

// ── Label maps (Spanish first, French fallback) ───────────────────────────────

const CONDITION_LABELS: Record<string, Record<string, string>> = {
  es: {
    neuf_etiquette:      "Nuevo con etiqueta",
    neuf_sans_etiquette: "Nuevo sin etiqueta",
    tres_bon:            "Muy buen estado",
    bon:                 "Buen estado",
    acceptable:          "Aceptable",
  },
  fr: {
    neuf_etiquette:      "Neuf avec étiquette",
    neuf_sans_etiquette: "Neuf sans étiquette",
    tres_bon:            "Très bon état",
    bon:                 "Bon état",
    acceptable:          "Satisfaisant",
  },
};

// Vinted.es category path for sneakers
const CATEGORY_PATH: Record<string, string[]> = {
  men:   ["Hombre", "Calzado", "Zapatillas"],
  women: ["Mujer",  "Calzado", "Zapatillas"],
};

// ── Cookie parsing ────────────────────────────────────────────────────────────

function parseSessionCookies(cookieStr: string, domain: string): CookieParam[] {
  const result: CookieParam[] = [];
  for (const part of cookieStr.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name  = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || !value) continue;
    result.push({
      name,
      value,
      domain: `.vinted.${domain}`,
      path: "/",
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    });
  }
  return result;
}

// ── Image helpers ─────────────────────────────────────────────────────────────

async function saveBase64ToTemp(dataUrl: string): Promise<string> {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) throw new Error("Invalid base64 data URL");
  const [, mime, data] = m;
  const ext = mime.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
  const file = path.join(os.tmpdir(), `vinted_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

async function downloadToTemp(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  const ext  = url.split(".").pop()?.split("?")[0] || "jpg";
  const file = path.join(os.tmpdir(), `vinted_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(file, Buffer.from(buf));
  return file;
}

async function screenshot64(page: Page): Promise<string> {
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 55 });
    return `data:image/jpeg;base64,${Buffer.from(buf as Uint8Array).toString("base64")}`;
  } catch { return ""; }
}

// ── React-aware field filling ─────────────────────────────────────────────────

async function fillReactInput(page: Page, selector: string, value: string): Promise<void> {
  await page.waitForSelector(selector, { visible: true, timeout: 12000 });
  await page.focus(selector);
  // Select all existing text and replace
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Delete");
  await page.type(selector, value, { delay: 18 });
}

// ── Autocomplete dropdown select ──────────────────────────────────────────────

async function pickFromDropdown(
  page: Page,
  inputSel: string,
  value: string,
): Promise<boolean> {
  try {
    await page.waitForSelector(inputSel, { visible: true, timeout: 8000 });
    // Clear + type
    await fillReactInput(page, inputSel, value);
    await page.waitForFunction(
      (sel: string) => {
        const input = document.querySelector(sel) as HTMLInputElement;
        return !!input?.value && input.value.length > 0;
      },
      { timeout: 3000 },
      inputSel
    ).catch(() => {});
    await sleep(700);

    // Try to click first autocomplete option
    const optionSelectors = [
      '[data-testid="dropdown-item"]',
      '[class*="dropdown__item"]',
      '[class*="Dropdown__item"]',
      'li[role="option"]',
      '[role="option"]',
      '[class*="suggestion"]',
    ];
    for (const optSel of optionSelectors) {
      const found = await page.$(optSel);
      if (found) {
        await found.click();
        return true;
      }
    }
    // Fallback: press Enter
    await page.keyboard.press("Enter");
    await sleep(300);
    return true;
  } catch (e: any) {
    console.warn(`[VintedPublisher] pickFromDropdown(${inputSel}, ${value}): ${e.message}`);
    return false;
  }
}

// ── Category selection (multi-level) ─────────────────────────────────────────

async function selectCategory(
  page: Page,
  levels: string[],
  emit: (s: string, m: string) => void,
): Promise<void> {
  // Click the category trigger
  const catTriggers = [
    '[data-testid="catalog-select-dropdown-input"]',
    '[data-testid="category-select"]',
    'input[placeholder*="ategoría"]',
    'input[placeholder*="atégorie"]',
  ];
  let triggered = false;
  for (const sel of catTriggers) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 4000 });
      await page.click(sel);
      triggered = true;
      break;
    } catch { /* try next */ }
  }
  if (!triggered) { emit("category_warn", "⚠️ No se encontró el campo de categoría"); return; }

  await sleep(800);

  for (const level of levels) {
    const clicked = await page.evaluate((text: string) => {
      // Find any clickable element whose text matches (case-insensitive)
      const candidates = Array.from(document.querySelectorAll(
        "button, li, [role='option'], [data-testid*='category'], [class*='catalog'], [class*='category']"
      ));
      for (const el of candidates) {
        const txt = (el as HTMLElement).innerText?.trim() || "";
        if (txt.toLowerCase().includes(text.toLowerCase())) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, level);

    if (clicked) {
      emit("category_level", `  ↳ ${level} ✓`);
    } else {
      emit("category_warn", `  ⚠️ No encontrado en categoría: "${level}"`);
    }
    await sleep(600);
  }
}

// ── Condition selection ───────────────────────────────────────────────────────

async function selectCondition(page: Page, label: string): Promise<void> {
  await page.evaluate((text: string) => {
    // Try visible labels / radio buttons / select options
    const allLabels = Array.from(document.querySelectorAll(
      "label, [role='radio'], [role='option'], [data-testid*='status'], [data-testid*='condition']"
    ));
    for (const el of allLabels) {
      const t = (el as HTMLElement).innerText?.trim() || "";
      if (t.toLowerCase().includes(text.toLowerCase())) {
        (el as HTMLElement).click();
        return;
      }
    }
    // Fallback: <select id="status_id">
    const sel = document.querySelector("#status_id") as HTMLSelectElement;
    if (sel) {
      for (const opt of Array.from(sel.options)) {
        if (opt.text.toLowerCase().includes(text.toLowerCase())) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
      }
    }
  }, label);
}

// ── Package size selection ────────────────────────────────────────────────────

async function selectPackageSize(page: Page, size: "small" | "medium" | "large"): Promise<void> {
  const idxMap = { small: 0, medium: 1, large: 2 };
  const idx = idxMap[size] ?? 0;
  await page.evaluate((n: number) => {
    const cells = Array.from(document.querySelectorAll(
      '[data-testid$="-package-size--cell"], [data-testid*="package"]'
    ));
    if (cells[n]) (cells[n] as HTMLElement).click();
  }, idx);
}

// ── Submit ────────────────────────────────────────────────────────────────────

async function clickPublish(page: Page): Promise<void> {
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const submitKeywords = ["publica", "upload", "télécharge", "añadir artículo", "vendre", "sell"];
    const btn = btns.find(b => {
      const t = (b.textContent || "").trim().toLowerCase();
      return submitKeywords.some(k => t.includes(k)) || b.type === "submit";
    });
    if (btn) (btn as HTMLElement).click();
  });
}

// ── Utility ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ═════════════════════════════════════════════════════════════════════════════
// Main export: publishToVinted
// ═════════════════════════════════════════════════════════════════════════════

export async function publishToVinted(
  sessionCookie: string,
  bearerToken: string | null,
  listing: VintedListingPayload,
  onProgress: ProgressFn,
): Promise<{ published: boolean; vintedId?: string; error?: string }> {
  const domain = listing.domain || "es";
  const emit = (step: string, message: string, screenshot?: string) =>
    onProgress({ type: "log", step, message, screenshot });

  const tmpFiles: string[] = [];
  let browser: Browser | null = null;

  try {
    // ── 1. Launch browser ───────────────────────────────────────────────────
    emit("start", "🚀 Iniciando Chrome...");
    // En Railway (Linux) usamos el Chromium del sistema vía PUPPETEER_EXECUTABLE_PATH.
    // Fallback: buscar chromium/google-chrome en PATH.
    // En local (macOS/Windows) Puppeteer usa su Chrome bundled.
    let executablePath: string | undefined = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (!executablePath && process.platform === "linux") {
      const { execSync } = await import("child_process");
      for (const bin of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
        try {
          const p = execSync(`which ${bin} 2>/dev/null`).toString().trim();
          if (p) { executablePath = p; break; }
        } catch { /* not found */ }
      }
    }

    browser = await puppeteer.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote",
        "--disable-extensions",
        "--disable-default-apps",
        "--disable-background-networking",
        "--disable-client-side-phishing-detection",
        "--no-first-run",
      ],
    });

    const page = await browser.newPage();

    // Stealth headers
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({
      "Accept-Language": domain === "fr"
        ? "fr-FR,fr;q=0.9,en;q=0.8"
        : "es-ES,es;q=0.9,en;q=0.8",
    });

    // ── 2. Inject session cookies ───────────────────────────────────────────
    emit("cookies", "🍪 Configurando sesión...");
    const cookies = parseSessionCookies(sessionCookie, domain);
    if (bearerToken) {
      cookies.push({
        name: "access_token_web",
        value: bearerToken.replace(/^Bearer\s+/i, ""),
        domain: `.vinted.${domain}`,
        path: "/",
        secure: true,
        sameSite: "Lax",
      });
    }
    if (cookies.length) await page.setCookie(...cookies);

    // ── 3. Navigate to new item form ────────────────────────────────────────
    emit("navigate", `🌐 Abriendo vinted.${domain}/items/new...`);
    await page.goto(`https://www.vinted.${domain}/items/new`, {
      waitUntil: "networkidle2",
      timeout: 35000,
    });

    const currentUrl = page.url();
    if (currentUrl.includes("/login") || currentUrl.includes("/oauth")) {
      const shot = await screenshot64(page);
      onProgress({
        type: "error",
        step: "auth",
        message: "❌ Sesión expirada. Abre Vinted en Chrome con la extensión activa para renovar las cookies.",
        screenshot: shot,
      });
      return { published: false, error: "session_expired" };
    }

    // ── 4. Wait for form ─────────────────────────────────────────────────────
    await page.waitForSelector(
      "#title, [data-testid='item-upload-form'], [data-testid='input-title']",
      { visible: true, timeout: 20000 }
    );
    emit("form", "📝 Formulario listo.");
    await sleep(400);

    // ── 5. Images ────────────────────────────────────────────────────────────
    emit("photos", `📸 Preparando ${listing.images.length} foto(s)...`);
    const filePaths: string[] = [];
    for (const img of listing.images.slice(0, 8)) {
      try {
        if (img.startsWith("data:")) {
          const f = await saveBase64ToTemp(img);
          tmpFiles.push(f);
          filePaths.push(f);
        } else if (img.startsWith("http")) {
          const f = await downloadToTemp(img);
          tmpFiles.push(f);
          filePaths.push(f);
        } else if (img.startsWith("/") && fs.existsSync(img)) {
          filePaths.push(img);
        }
      } catch (e: any) {
        emit("photos_warn", `⚠️ Foto omitida: ${e.message}`);
      }
    }

    if (filePaths.length) {
      const fileInput = await page.$('input[type="file"][accept*="image"], input[type="file"]');
      if (fileInput) {
        await (fileInput as any).uploadFile(...filePaths);
        await sleep(2500); // wait for upload progress
        emit("photos_ok", `✅ ${filePaths.length} foto(s) subidas.`);
      } else {
        emit("photos_warn", "⚠️ Input de fotos no encontrado.");
      }
    }

    // ── 6. Title ─────────────────────────────────────────────────────────────
    emit("title", "✏️ Rellenando título...");
    await fillReactInput(page, "#title", listing.title);
    await sleep(300);
    emit("title_ok", `✅ Título: "${listing.title}"`);

    // ── 7. Description ───────────────────────────────────────────────────────
    if (listing.description?.trim()) {
      emit("description", "✏️ Rellenando descripción...");
      await fillReactInput(page, "#description", listing.description);
      await sleep(300);
      emit("description_ok", "✅ Descripción rellenada.");
    }

    // ── 8. Category ──────────────────────────────────────────────────────────
    emit("category", "📁 Seleccionando categoría...");
    const catPath = CATEGORY_PATH[listing.gender] || CATEGORY_PATH.men;
    await selectCategory(page, catPath, emit);
    emit("category_ok", "✅ Categoría seleccionada.");
    await sleep(400);

    // ── 9. Brand ─────────────────────────────────────────────────────────────
    emit("brand", `🏷️ Seleccionando marca: ${listing.brand}...`);
    await pickFromDropdown(
      page,
      '[data-testid="brand-select-dropdown-input"]',
      listing.brand
    );
    await sleep(500);
    emit("brand_ok", `✅ Marca: ${listing.brand}`);

    // ── 10. Size ──────────────────────────────────────────────────────────────
    if (listing.size) {
      emit("size", `📏 Seleccionando talla: ${listing.size}...`);
      await pickFromDropdown(
        page,
        '[data-testid="size-select-dropdown-input"]',
        listing.size
      );
      await sleep(500);
      emit("size_ok", `✅ Talla: ${listing.size}`);
    }

    // ── 11. Condition ─────────────────────────────────────────────────────────
    emit("condition", "⭐ Seleccionando estado...");
    const condLabel =
      (CONDITION_LABELS[domain] ?? CONDITION_LABELS.es)[listing.condition] ??
      "Nuevo sin etiqueta";
    await selectCondition(page, condLabel);
    await sleep(400);
    emit("condition_ok", `✅ Estado: ${condLabel}`);

    // ── 12. Price ─────────────────────────────────────────────────────────────
    emit("price", `💶 Precio: ${listing.price}€...`);
    await fillReactInput(page, "#price", String(listing.price));
    await sleep(300);
    emit("price_ok", `✅ Precio: ${listing.price}€`);

    // ── 13. Package size ──────────────────────────────────────────────────────
    emit("package", "📦 Seleccionando tamaño de envío...");
    await selectPackageSize(page, listing.packageSize);
    await sleep(300);
    emit("package_ok", `✅ Envío: ${listing.packageSize}`);

    // Screenshot before submit
    const preShot = await screenshot64(page);
    emit("form_done", "✅ Formulario completo. Publicando...", preShot);
    await sleep(500);

    // ── 14. Submit ────────────────────────────────────────────────────────────
    emit("submit", "🚀 Enviando anuncio...");
    await clickPublish(page);
    await sleep(3500);

    // ── 15. Verify ────────────────────────────────────────────────────────────
    const finalUrl = page.url();
    const finalShot = await screenshot64(page);

    // Success if URL changed to a specific item page (not /new)
    if (
      (finalUrl.includes("/items/") || finalUrl.match(/\/\d{7,}-/)) &&
      !finalUrl.endsWith("/new")
    ) {
      const vintedIdMatch = finalUrl.match(/\/(\d{7,})-/) || finalUrl.match(/items\/(\d+)/);
      const vintedId = vintedIdMatch?.[1];
      onProgress({
        type: "done",
        step: "published",
        message: `✅ ¡Publicado en Vinted! ${finalUrl}`,
        screenshot: finalShot,
      });
      return { published: true, vintedId };
    }

    // Could still be success (some domains stay on /new briefly)
    onProgress({
      type: "done",
      step: "maybe_published",
      message: "⚠️ Enviado. Comprueba tu Vinted para confirmar la publicación.",
      screenshot: finalShot,
    });
    return { published: true };

  } catch (err: any) {
    console.error("[VintedPublisher]", err);
    onProgress({ type: "error", step: "failed", message: `❌ Error: ${err.message}` });
    return { published: false, error: err.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}
