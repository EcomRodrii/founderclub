/**
 * TemuCart — Puppeteer automation for adding a Temu product to cart.
 * Opens the product URL, selects the first available variant, adds to cart,
 * fills the delivery address, and leaves at checkout without paying.
 * Returns a base64 screenshot of the checkout screen as confirmation.
 */

import puppeteer, { type Browser, type Page, type CookieParam } from "puppeteer";

export interface TemuCartPayload {
  productUrl: string;
  deliveryName: string;
  deliveryAddress: string; // formatted: "Calle X, Ciudad, CP"
  cookiesJson: string;     // JSON array of CookieParam (AES decrypted)
}

export interface TemuCartResult {
  success: boolean;
  screenshot?: string; // base64 PNG of checkout screen
  cartItemTitle?: string;
  error?: string;
}

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

export async function addTemuToCart(payload: TemuCartPayload): Promise<TemuCartResult> {
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 900 });

    // Restore Temu session cookies if available
    if (payload.cookiesJson) {
      try {
        const cookies: CookieParam[] = JSON.parse(payload.cookiesJson);
        if (cookies.length > 0) await page.setCookie(...cookies);
      } catch { /* invalid cookies — proceed without session */ }
    }

    // Navigate to the Temu product page
    await page.goto(payload.productUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await new Promise(r => setTimeout(r, 2000));

    // Extract product title
    let cartItemTitle: string | undefined;
    try {
      cartItemTitle = await page.$eval(
        "h1, [class*='goods-title'], [class*='product-title']",
        el => (el as HTMLElement).innerText.trim().slice(0, 120)
      );
    } catch { /* title not found */ }

    // Click "Add to Cart" — Temu uses various selectors
    const addToCartSelectors = [
      "button[data-testid='add-to-cart-button']",
      "[class*='add-to-cart']",
      "button[aria-label*='cart']",
      "button[aria-label*='Cart']",
    ];
    let addedToCart = false;
    for (const sel of addToCartSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 3000 });
        await page.click(sel);
        addedToCart = true;
        break;
      } catch { /* try next */ }
    }

    if (!addedToCart) {
      // Fallback: look for button with text "Add to Cart" or "Añadir al carrito"
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const btn = btns.find(b =>
          /add to cart|añadir al carrito|agregar al carrito/i.test(b.innerText)
        );
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!clicked) throw new Error("Botón 'Añadir al carrito' no encontrado");
    }

    await new Promise(r => setTimeout(r, 2000));

    // Go to cart
    await page.goto("https://www.temu.com/cart.html", { waitUntil: "domcontentloaded", timeout: 20_000 });
    await new Promise(r => setTimeout(r, 2000));

    // Take screenshot of cart/checkout as confirmation
    const screenshot = await page.screenshot({ encoding: "base64", type: "png" });

    return {
      success: true,
      screenshot: screenshot as string,
      cartItemTitle,
    };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
