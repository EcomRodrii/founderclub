/**
 * TemuLogin — Puppeteer automation for Temu email+password login.
 *
 * Key challenges:
 *  - Temu is a React SPA: DOM is ready but inputs don't exist until JS hydrates.
 *  - Temu detects headless Chrome via navigator.webdriver; must override it.
 *  - React controlled inputs ignore programmatic `.value = x` — must use the
 *    native HTMLInputElement value setter to trigger React's synthetic events.
 *  - Temu may show cookie/promo overlays that block interaction.
 */

import puppeteer, { type Browser, type Page, type CookieParam } from "puppeteer";

export interface TemuLoginResult {
  success: boolean;
  cookiesJson?: string;
  userEmail?: string;
  error?: string;
  needsOtp?: boolean;
  debugScreenshot?: string; // base64 PNG if failed, for diagnostics
}

// ── Browser ────────────────────────────────────────────────────────────────────
async function launchBrowser(): Promise<Browser> {
  let executablePath: string | undefined = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (!executablePath && process.platform === "linux") {
    const { execSync } = await import("child_process");
    for (const bin of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
      try {
        const p = execSync(`which ${bin} 2>/dev/null`).toString().trim();
        if (p) { executablePath = p; break; }
      } catch {}
    }
  }
  return puppeteer.launch({
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
      "--no-first-run",
      "--disable-blink-features=AutomationControlled", // hide headless
      "--window-size=1366,768",
    ],
  });
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Anti-bot evasion injected before every page load ──────────────────────────
async function setupPage(page: Page) {
  await page.evaluateOnNewDocument(() => {
    // Remove the webdriver flag that Temu checks
    Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true });

    // Make plugins look real
    Object.defineProperty(navigator, "plugins", {
      get: () => ({ length: 3, 0: { name: "Chrome PDF Plugin" }, 1: { name: "Chrome PDF Viewer" }, 2: { name: "Native Client" } }),
      configurable: true,
    });

    // Realistic languages
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en", "es"],
      configurable: true,
    });

    // Hide that Chrome is running in headless mode
    (window as any).chrome = { runtime: {} };
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 768 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
}

// ── Fill a React-controlled input via the native value setter ─────────────────
async function reactFillInput(page: Page, selector: string, text: string): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout: 8000, visible: true });
    await page.click(selector);
    return await page.evaluate((sel, val) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (!el) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, selector, text);
  } catch {
    return false;
  }
}

// ── Find any visible text/email input on the page via evaluate ────────────────
async function findEmailInputSelector(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input"));
    const candidates = inputs.filter(i => {
      if (i.offsetParent === null) return false; // not visible
      const t = i.type?.toLowerCase();
      const p = (i.placeholder || "").toLowerCase();
      const n = (i.name || "").toLowerCase();
      const a = (i.getAttribute("autocomplete") || "").toLowerCase();
      return (
        t === "email" ||
        t === "text" ||
        p.includes("email") || p.includes("mail") ||
        n.includes("email") || n.includes("mail") ||
        a === "email" || a === "username"
      );
    });
    if (!candidates.length) return null;
    const el = candidates[0];
    // Build a unique-enough selector
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `input[name="${el.name}"]`;
    if (el.type === "email") return 'input[type="email"]';
    return null;
  });
}

// ── Find password input ───────────────────────────────────────────────────────
async function findPasswordInputSelector(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="password"]'));
    const visible = inputs.filter(i => i.offsetParent !== null);
    if (!visible.length) return null;
    const el = visible[0] as HTMLInputElement;
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `input[name="${el.name}"]`;
    return 'input[type="password"]';
  });
}

// ── Dismiss overlays (cookie consent, promos, welcome popups) ────────────────
async function dismissOverlays(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      // Click any visible "close" / "accept" / "skip" button in overlays
      const keywords = /close|accept|ok|got it|skip|dismiss|no thanks|decline|×|✕|allow|agree/i;
      const buttons = Array.from(document.querySelectorAll("button, [role=button], a[href='#']"));
      for (const btn of buttons) {
        const el = btn as HTMLElement;
        if (el.offsetParent !== null && keywords.test(el.innerText || el.getAttribute("aria-label") || "")) {
          el.click();
        }
      }
    });
    await delay(600);
  } catch {}
}

// ── Click "Sign in" if needed to reveal the login form ───────────────────────
async function clickSignInIfNeeded(page: Page): Promise<void> {
  try {
    const clicked = await page.evaluate(() => {
      const keywords = /sign in|log in|login|iniciar sesión/i;
      const els = Array.from(document.querySelectorAll("button, a, [role=button]"));
      for (const el of els) {
        const h = el as HTMLElement;
        if (h.offsetParent !== null && keywords.test(h.innerText || h.getAttribute("aria-label") || "")) {
          h.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) await delay(2000);
  } catch {}
}

// ── Click the submit/continue button ─────────────────────────────────────────
async function clickSubmit(page: Page): Promise<void> {
  try {
    const clicked = await page.evaluate(() => {
      const keywords = /continue|next|sign in|log in|submit|siguiente|continuar|confirm/i;
      const buttons = Array.from(document.querySelectorAll("button[type=submit], button"));
      for (const b of buttons) {
        const el = b as HTMLButtonElement;
        if (el.offsetParent !== null && !el.disabled && keywords.test(el.innerText)) {
          el.click();
          return true;
        }
      }
      // Fallback: click the only visible button
      const visible = buttons.filter(b => (b as HTMLElement).offsetParent !== null && !(b as HTMLButtonElement).disabled);
      if (visible.length === 1) { (visible[0] as HTMLElement).click(); return true; }
      return false;
    });
    if (!clicked) await page.keyboard.press("Enter");
  } catch {
    await page.keyboard.press("Enter");
  }
}

// ── Main login function ───────────────────────────────────────────────────────
export async function loginToTemu(email: string, password: string): Promise<TemuLoginResult> {
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await setupPage(page);

    // Navigate to login page — wait for network to settle (not just DOM parse)
    await page.goto("https://www.temu.com/login.html", {
      waitUntil: "networkidle2",
      timeout: 45_000,
    });
    await delay(3000);

    // Dismiss cookie / welcome overlays
    await dismissOverlays(page);
    await delay(800);

    // --- Try to find the email input ---
    let emailSelector = await findEmailInputSelector(page);

    if (!emailSelector) {
      // Maybe we're on the homepage and need to click "Sign in"
      await clickSignInIfNeeded(page);
      await delay(2500);
      await dismissOverlays(page);
      emailSelector = await findEmailInputSelector(page);
    }

    if (!emailSelector) {
      // Last resort: try navigating directly to the sign-in page variant
      await page.goto("https://www.temu.com/login.html?refer_page_name=home", {
        waitUntil: "networkidle2",
        timeout: 30_000,
      });
      await delay(3000);
      await dismissOverlays(page);
      emailSelector = await findEmailInputSelector(page);
    }

    if (!emailSelector) {
      const screenshot = await page.screenshot({ encoding: "base64", type: "png" }).catch(() => undefined);
      const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 500)).catch(() => "");
      return {
        success: false,
        error: `No se encontró el formulario de login de Temu. ` +
               (pageText.toLowerCase().includes("captcha") || pageText.toLowerCase().includes("robot")
                 ? "Temu está mostrando un captcha. Inténtalo más tarde."
                 : "La web puede haber cambiado o está detectando el bot."),
        debugScreenshot: screenshot as string | undefined,
      };
    }

    // Fill email
    const emailFilled = await reactFillInput(page, emailSelector, email);
    if (!emailFilled) {
      return { success: false, error: "No se pudo rellenar el email en Temu." };
    }
    await delay(600);

    // Some flows: click "Continue" first, password on next screen
    const pwdVisibleNow = await findPasswordInputSelector(page);
    if (!pwdVisibleNow) {
      await clickSubmit(page);
      await delay(2500);
    }

    // Fill password
    const pwdSelector = await findPasswordInputSelector(page);
    if (!pwdSelector) {
      return { success: false, error: "No apareció el campo de contraseña después del email." };
    }
    const pwdFilled = await reactFillInput(page, pwdSelector, password);
    if (!pwdFilled) {
      return { success: false, error: "No se pudo rellenar la contraseña en Temu." };
    }
    await delay(600);

    // Submit login
    await clickSubmit(page);
    await delay(5000); // wait for redirect / error

    // --- Analyse result ---
    const url = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText?.toLowerCase() || "").catch(() => "");

    if (
      bodyText.includes("verification code") ||
      bodyText.includes("código de verificación") ||
      bodyText.includes("verify your") ||
      bodyText.includes("otp") ||
      url.includes("verify") || url.includes("otp")
    ) {
      return { success: false, needsOtp: true, error: "Temu ha enviado un código de verificación (2FA). Desactiva la verificación en dos pasos en tu cuenta Temu e inténtalo de nuevo." };
    }

    if (bodyText.includes("captcha") || bodyText.includes("robot") || bodyText.includes("verify you are human")) {
      return { success: false, error: "Temu está mostrando un captcha. Inténtalo más tarde." };
    }

    if (
      bodyText.includes("incorrect password") || bodyText.includes("contraseña incorrecta") ||
      bodyText.includes("wrong password") || bodyText.includes("invalid email") ||
      bodyText.includes("no account found") || bodyText.includes("cuenta no encontrada") ||
      bodyText.includes("email or password is incorrect")
    ) {
      return { success: false, error: "Email o contraseña incorrectos." };
    }

    // Check for successful login: should have navigated away from /login
    const stillOnLogin = url.includes("/login") && !url.includes("?from=");

    if (stillOnLogin) {
      // Check for user avatar / account info that proves we're logged in
      const loggedIn = await page.evaluate(() => {
        const userEls = document.querySelectorAll('[class*="user-name"], [class*="avatar"], [class*="account-name"], [class*="my-account"], [data-testid*="user"]');
        return userEls.length > 0;
      });
      if (!loggedIn) {
        const screenshot = await page.screenshot({ encoding: "base64", type: "png" }).catch(() => undefined);
        return {
          success: false,
          error: "El login no completó correctamente. Verifica el email y contraseña.",
          debugScreenshot: screenshot as string | undefined,
        };
      }
    }

    // Grab all cookies from temu.com
    await page.goto("https://www.temu.com/", { waitUntil: "domcontentloaded", timeout: 20_000 });
    await delay(1500);
    const cookies: CookieParam[] = await page.cookies("https://www.temu.com");

    if (cookies.length === 0) {
      return { success: false, error: "Login completado pero no se pudieron capturar las cookies de sesión." };
    }

    return { success: true, cookiesJson: JSON.stringify(cookies), userEmail: email };

  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
