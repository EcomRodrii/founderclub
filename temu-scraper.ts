/**
 * TemuScraper — Extracts product data from a public Temu product URL.
 * Strategy 1: fetch() + parse JSON-LD / window.__DATA__ (no Puppeteer).
 * Strategy 2: Puppeteer headless render if strategy 1 yields insufficient data.
 */

import puppeteer, { type Browser } from "puppeteer";

export interface TemuProductData {
  title: string;
  description: string;
  price: number | null;   // price in euros
  images: string[];       // at least 1 URL
  brand: string;
}

// ── Puppeteer launcher (identical to temu-login.ts / temu-cart.ts) ────────────

async function launchBrowser(): Promise<Browser> {
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
  return puppeteer.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--single-process", "--no-zygote",
      "--disable-extensions", "--disable-default-apps",
      "--disable-background-networking", "--no-first-run",
    ],
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePrice(raw: unknown): number | null {
  if (raw == null) return null;
  const n = parseFloat(String(raw).replace(/[^0-9.,]/g, "").replace(",", "."));
  return isNaN(n) ? null : n;
}

function extractImages(obj: unknown, found: Set<string> = new Set()): string[] {
  if (!obj || typeof obj !== "object") return [];
  if (Array.isArray(obj)) {
    for (const item of obj) extractImages(item, found);
  } else {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (
        (k === "url" || k === "contentUrl" || k === "image" || k === "src") &&
        typeof v === "string" &&
        /\.(jpg|jpeg|png|webp)/i.test(v)
      ) {
        found.add(v.startsWith("//") ? `https:${v}` : v);
      } else {
        extractImages(v, found);
      }
    }
  }
  return [...found];
}

/** Parse JSON-LD blocks and window.__DATA__ / window.rawData from HTML. */
function parseHtmlData(html: string): Partial<TemuProductData> {
  const result: Partial<TemuProductData> = {};

  // ── JSON-LD ──
  const ldMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of ldMatches) {
    try {
      const obj = JSON.parse(m[1]);
      const schemas: unknown[] = Array.isArray(obj) ? obj : [obj];
      for (const schema of schemas) {
        if (!schema || typeof schema !== "object") continue;
        const s = schema as Record<string, unknown>;
        if (s["@type"] === "Product" || s["name"]) {
          if (!result.title && typeof s["name"] === "string") result.title = s["name"];
          if (!result.description && typeof s["description"] === "string") result.description = s["description"];
          if (!result.brand && s["brand"]) {
            const b = s["brand"] as Record<string, unknown>;
            result.brand = typeof b["name"] === "string" ? b["name"] : String(b);
          }
          if (s["offers"]) {
            const offers = Array.isArray(s["offers"]) ? s["offers"] : [s["offers"]];
            for (const offer of offers) {
              const o = offer as Record<string, unknown>;
              const p = parsePrice(o["price"] ?? o["lowPrice"]);
              if (p !== null && !result.price) result.price = p;
            }
          }
          const imgs = extractImages(s["image"] ?? s["images"]);
          if (imgs.length && !result.images?.length) result.images = imgs;
        }
      }
    } catch { /* invalid JSON */ }
  }

  // ── window.__DATA__ / window.__INITIAL_STATE__ / rawData ──
  const dataPatterns = [
    /window\.__DATA__\s*=\s*(\{[\s\S]*?\});\s*(?:window|<\/script>)/,
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});\s*(?:window|<\/script>)/,
    /window\.rawData\s*=\s*(\{[\s\S]*?\});\s*(?:window|<\/script>)/,
    /"goodsInfo"\s*:\s*(\{[\s\S]{10,5000}?\})\s*,\s*"[a-z]/i,
    /"product"\s*:\s*(\{[\s\S]{10,5000}?\})\s*,\s*"[a-z]/i,
  ];

  for (const re of dataPatterns) {
    const m = html.match(re);
    if (!m) continue;
    try {
      const obj = JSON.parse(m[1]) as Record<string, unknown>;
      if (!result.title) {
        result.title =
          (obj["goodsName"] ?? obj["title"] ?? obj["name"]) as string | undefined;
      }
      if (!result.description) {
        result.description = (obj["goodsDesc"] ?? obj["description"] ?? obj["desc"]) as string | undefined;
      }
      if (!result.price) {
        result.price = parsePrice(
          obj["salePrice"] ?? obj["price"] ?? obj["originalPrice"] ?? obj["lowPrice"]
        );
      }
      if (!result.images?.length) {
        const imgs = extractImages(obj["gallery"] ?? obj["images"] ?? obj["imgList"] ?? obj);
        if (imgs.length) result.images = imgs;
      }
      if (!result.brand) {
        result.brand = (obj["brandName"] ?? obj["brand"]) as string | undefined;
      }
    } catch { /* invalid JSON */ }
  }

  // ── OG / meta tags fallback ──
  if (!result.title) {
    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (ogTitle) result.title = ogTitle[1];
  }
  if (!result.description) {
    const ogDesc = html.match(/<meta[^>]+(?:property=["']og:description["']|name=["']description["'])[^>]+content=["']([^"']+)["']/i);
    if (ogDesc) result.description = ogDesc[1];
  }
  if (!result.images?.length) {
    const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (ogImg) result.images = [ogImg[1]];
  }

  return result;
}

function isSufficient(data: Partial<TemuProductData>): boolean {
  return !!(data.title && data.images && data.images.length > 0);
}

// ── Strategy 1: plain fetch ───────────────────────────────────────────────────

async function fetchStrategy(url: string): Promise<Partial<TemuProductData>> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const html = await res.text();
  return parseHtmlData(html);
}

// ── Strategy 2: Puppeteer ─────────────────────────────────────────────────────

async function puppeteerStrategy(url: string): Promise<Partial<TemuProductData>> {
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await new Promise(r => setTimeout(r, 3000));

    const html = await page.content();
    const fromHtml = parseHtmlData(html);
    if (isSufficient(fromHtml)) return fromHtml;

    // Direct DOM extraction as final fallback
    const dom = await page.evaluate(() => {
      const getText = (sel: string) =>
        (document.querySelector(sel) as HTMLElement | null)?.innerText?.trim() ?? "";
      const getMeta = (prop: string) =>
        (document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`) as HTMLMetaElement | null)
          ?.content ?? "";

      const title =
        getText("h1") ||
        getText("[class*='goods-title']") ||
        getText("[class*='product-title']") ||
        getMeta("og:title");

      const description =
        getText("[class*='goods-desc']") ||
        getText("[class*='product-desc']") ||
        getMeta("description") ||
        getMeta("og:description");

      const priceRaw =
        getText("[class*='price-val']") ||
        getText("[class*='sale-price']") ||
        getText("[class*='goods-price']") ||
        getText("[class*='product-price']");

      const images = Array.from(
        document.querySelectorAll<HTMLImageElement>(
          "[class*='goods-img'] img, [class*='product-img'] img, [class*='gallery'] img, [class*='swiper'] img"
        )
      )
        .map(img => img.src || img.dataset["src"] || "")
        .filter(src => src && /\.(jpg|jpeg|png|webp)/i.test(src));

      const ogImage = getMeta("og:image");
      if (ogImage && !images.includes(ogImage)) images.unshift(ogImage);

      const brand =
        getText("[class*='brand-name']") ||
        getText("[class*='goods-brand']") ||
        getText("[itemprop='brand']") ||
        "";

      return { title, description, priceRaw, images, brand };
    });

    return {
      title: dom.title || undefined,
      description: dom.description || undefined,
      price: parsePrice(dom.priceRaw),
      images: dom.images.length ? dom.images : undefined,
      brand: dom.brand || undefined,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function scrapeTemuProduct(url: string): Promise<TemuProductData> {
  // Strategy 1: plain fetch
  let data: Partial<TemuProductData> = {};
  try {
    data = await fetchStrategy(url);
  } catch { /* fall through to Puppeteer */ }

  // Strategy 2: Puppeteer if fetch didn't yield enough
  if (!isSufficient(data)) {
    try {
      const puppeteerData = await puppeteerStrategy(url);
      // Merge: prefer Puppeteer values where fetch was missing
      data = {
        title: data.title || puppeteerData.title,
        description: data.description || puppeteerData.description,
        price: data.price ?? puppeteerData.price ?? null,
        images: (data.images?.length ? data.images : puppeteerData.images) ?? [],
        brand: data.brand || puppeteerData.brand,
      };
    } catch (err: any) {
      if (!isSufficient(data)) {
        throw new Error(`No se pudieron extraer datos del producto: ${err?.message ?? String(err)}`);
      }
    }
  }

  if (!data.title) throw new Error("No se pudo extraer el título del producto de Temu.");
  if (!data.images?.length) throw new Error("No se pudieron extraer imágenes del producto de Temu.");

  return {
    title: data.title,
    description: data.description ?? "",
    price: data.price ?? null,
    images: data.images,
    brand: data.brand ?? "",
  };
}
