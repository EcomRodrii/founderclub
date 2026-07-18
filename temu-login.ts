/**
 * TemuLogin — Puppeteer automation for Temu email+password login.
 *
 * Uses puppeteer-extra with the stealth plugin to bypass Temu's bot detection
 * (patches navigator.webdriver, Chrome runtime, permissions, WebGL, etc.).
 * Direct connection without proxy — stealth handles the fingerprinting.
 * React input trick: native HTMLInputElement value setter + dispatchEvent.
 */

import { type Browser, type Page, type CookieParam } from "puppeteer";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const puppeteerExtra = require("puppeteer-extra");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

export interface TemuLoginResult {
  success: boolean;
  cookiesJson?: string;
  userEmail?: string;
  error?: string;
  needsOtp?: boolean;
  debugScreenshot?: string;
}

// ── Browser ────────────────────────────────────────────────────────────────────
async function launchBrowser(): Promise<Browser> {
  puppeteerExtra.use(StealthPlugin() as any);

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

  return (puppeteerExtra as any).launch({
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
      "--window-size=1366,768",
    ],
  });
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Page setup ─────────────────────────────────────────────────────────────────
async function setupPage(page: Page) {
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 768 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
}

// ── Dismiss cookie / promo overlays ───────────────────────────────────────────
async function dismissOverlays(page: Page) {
  try {
    await page.evaluate(() => {
      const keywords = /close|accept|ok|got it|skip|dismiss|no thanks|×|✕|allow|agree/i;
      document.querySelectorAll<HTMLElement>("button, [role=button]").forEach(el => {
        if (el.offsetParent !== null && keywords.test(el.innerText || el.getAttribute("aria-label") || "")) {
          el.click();
        }
      });
    });
    await delay(500);
  } catch {}
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

// ── Find the email input selector on the current page ─────────────────────────
async function findEmailInputSelector(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
    const el = inputs.find(i => {
      if ((i as HTMLElement).offsetParent === null) return false;
      const t = i.type?.toLowerCase();
      const p = (i.placeholder || "").toLowerCase();
      const n = (i.name || "").toLowerCase();
      const a = (i.getAttribute("autocomplete") || "").toLowerCase();
      return t === "email" || t === "text" ||
        p.includes("email") || p.includes("mail") ||
        n.includes("email") || n.includes("mail") ||
        a === "email" || a === "username";
    });
    if (!el) return null;
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `input[name="${CSS.escape(el.name)}"]`;
    if (el.type === "email") return 'input[type="email"]';
    return null;
  });
}

// ── Find password input selector ──────────────────────────────────────────────
async function findPasswordInputSelector(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'))
      .filter(i => (i as HTMLElement).offsetParent !== null);
    if (!visible.length) return null;
    const el = visible[0];
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `input[name="${CSS.escape(el.name)}"]`;
    return 'input[type="password"]';
  });
}

// ── Click a sign-in / continue / submit button ────────────────────────────────
async function clickSignInOrSubmit(page: Page): Promise<void> {
  try {
    const clicked = await page.evaluate(() => {
      const keywords = /sign in|log in|login|continue|next|submit|confirm|iniciar|continuar|siguiente/i;
      const btns = Array.from(document.querySelectorAll<HTMLButtonElement>("button, [role=button]"));
      const btn = btns.find(b => b.offsetParent !== null && !b.disabled && keywords.test(b.innerText || b.getAttribute("aria-label") || ""));
      if (btn) { btn.click(); return true; }
      // If only one visible enabled button, click it
      const visible = btns.filter(b => b.offsetParent !== null && !b.disabled);
      if (visible.length === 1) { visible[0].click(); return true; }
      return false;
    });
    if (!clicked) await page.keyboard.press("Enter");
  } catch {
    await page.keyboard.press("Enter").catch(() => {});
  }
  await delay(2000);
}

// ── Main ───────────────────────────────────────────────────────────────────────
export async function loginToTemu(email: string, password: string): Promise<TemuLoginResult> {
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await setupPage(page);

    // Navigate — use networkidle2 so React has time to hydrate
    await page.goto("https://www.temu.com/login.html", {
      waitUntil: "networkidle2",
      timeout: 45_000,
    });
    await delay(2500);
    await dismissOverlays(page);

    // Find email input
    let emailSel = await findEmailInputSelector(page);

    if (!emailSel) {
      // Try clicking a "Sign in" link/button that might reveal the form
      const revealed = await page.evaluate(() => {
        const keywords = /sign in|log in|login|iniciar/i;
        const els = Array.from(document.querySelectorAll<HTMLElement>("button, a, [role=button]"));
        const el = els.find(e => e.offsetParent !== null && keywords.test(e.innerText || e.getAttribute("aria-label") || ""));
        if (el) { el.click(); return true; }
        return false;
      });
      if (revealed) {
        await delay(2500);
        await dismissOverlays(page);
        emailSel = await findEmailInputSelector(page);
      }
    }

    if (!emailSel) {
      // Last attempt: try the alternate login URL
      await page.goto("https://www.temu.com/login.html?refer_page_name=home&refer_page_id=10005", {
        waitUntil: "networkidle2",
        timeout: 30_000,
      });
      await delay(2500);
      await dismissOverlays(page);
      emailSel = await findEmailInputSelector(page);
    }

    if (!emailSel) {
      const screenshot = await page.screenshot({ encoding: "base64", type: "png" }).catch(() => undefined);
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500)).catch(() => "");
      const isCaptcha = /captcha|robot|verify you are human/i.test(bodyText);
      return {
        success: false,
        error: isCaptcha
          ? "Temu muestra un captcha. Inténtalo más tarde."
          : "No se encontró el formulario de login de Temu. La web puede haber cambiado.",
        debugScreenshot: screenshot as string | undefined,
      };
    }

    // Fill email
    const emailFilled = await reactFillInput(page, emailSel, email);
    if (!emailFilled) {
      return { success: false, error: "No se pudo rellenar el email." };
    }
    await delay(500);

    // If password field isn't visible yet, submit email first (two-step flow)
    if (!await findPasswordInputSelector(page)) {
      await clickSignInOrSubmit(page);
    }

    // Fill password
    const pwdSel = await findPasswordInputSelector(page);
    if (!pwdSel) {
      return { success: false, error: "No apareció el campo de contraseña. Verifica el email." };
    }
    const pwdFilled = await reactFillInput(page, pwdSel, password);
    if (!pwdFilled) {
      return { success: false, error: "No se pudo rellenar la contraseña." };
    }
    await delay(500);

    // Submit login
    await clickSignInOrSubmit(page);
    await delay(5000);

    // --- Analyse result ---
    const url = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText?.toLowerCase() || "").catch(() => "");

    if (/verification code|código de verificación|verify your|otp/i.test(bodyText) || url.includes("verify") || url.includes("otp")) {
      return { success: false, needsOtp: true, error: "Temu ha enviado un código de verificación (2FA). Desactiva la verificación en dos pasos en tu cuenta Temu e inténtalo de nuevo." };
    }

    if (/captcha|robot|verify you are human/i.test(bodyText)) {
      return { success: false, error: "Temu muestra un captcha. Inténtalo de nuevo en unos minutos." };
    }

    if (/incorrect password|contraseña incorrecta|wrong password|invalid email|no account found|email or password is incorrect/i.test(bodyText)) {
      return { success: false, error: "Email o contraseña incorrectos." };
    }

    // If still on login page, check for account UI
    if (url.includes("/login") && !url.includes("?from=")) {
      const loggedIn = await page.evaluate(() =>
        document.querySelectorAll('[class*="user-name"], [class*="avatar"], [class*="account-name"], [class*="my-account"]').length > 0
      );
      if (!loggedIn) {
        const screenshot = await page.screenshot({ encoding: "base64", type: "png" }).catch(() => undefined);
        return { success: false, error: "Login no completado. Verifica el email y contraseña.", debugScreenshot: screenshot as string | undefined };
      }
    }

    // Grab cookies
    await page.goto("https://www.temu.com/", { waitUntil: "domcontentloaded", timeout: 20_000 });
    await delay(1500);
    const cookies: CookieParam[] = await page.cookies("https://www.temu.com");

    if (!cookies.length) {
      return { success: false, error: "Login completado pero no se capturaron cookies de sesión." };
    }

    return { success: true, cookiesJson: JSON.stringify(cookies), userEmail: email };

  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
