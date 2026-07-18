/**
 * TemuLogin — Puppeteer automation to log into Temu with email+password
 * and capture the session cookies for future automation use.
 */

import puppeteer, { type Browser, type Page, type CookieParam } from "puppeteer";

export interface TemuLoginResult {
  success: boolean;
  cookiesJson?: string;   // JSON array of CookieParam — store encrypted
  userEmail?: string;
  error?: string;
  needsOtp?: boolean;     // true if Temu sent a verification code
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

async function tryClick(page: Page, selectors: string[], timeout = 5000): Promise<boolean> {
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout, visible: true });
      await page.click(sel);
      return true;
    } catch { /* try next */ }
  }
  return false;
}

async function tryType(page: Page, selectors: string[], text: string, timeout = 5000): Promise<boolean> {
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout, visible: true });
      await page.click(sel);
      await page.type(sel, text, { delay: 60 });
      return true;
    } catch { /* try next */ }
  }
  return false;
}

export async function loginToTemu(email: string, password: string): Promise<TemuLoginResult> {
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 900 });

    // Go to Temu login page
    await page.goto("https://www.temu.com/login.html", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await new Promise(r => setTimeout(r, 2000));

    // Check if already on login form or need to navigate
    let onLoginPage = await page.$('input[type="email"], input[placeholder*="email" i], input[placeholder*="correo" i]') !== null;

    if (!onLoginPage) {
      // Try clicking login/account button on homepage
      await tryClick(page, [
        "[data-testid='login-button']",
        "a[href*='login']",
        "[class*='login']",
        "[class*='sign-in']",
        "button[class*='account']",
      ]);
      await new Promise(r => setTimeout(r, 2000));
      onLoginPage = await page.$('input[type="email"], input[placeholder*="email" i]') !== null;
    }

    if (!onLoginPage) {
      return { success: false, error: "No se pudo encontrar el formulario de login de Temu. La web puede haber cambiado." };
    }

    // Fill email
    const emailSelectors = [
      'input[type="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="correo" i]',
      'input[name="email"]',
    ];
    const emailTyped = await tryType(page, emailSelectors, email);
    if (!emailTyped) {
      return { success: false, error: "No se pudo rellenar el email en Temu." };
    }

    await new Promise(r => setTimeout(r, 500));

    // Some flows: click "Continue" first, then enter password on next step
    const hasContinueBtn = await page.$('button[type="submit"]:not([aria-label*="password"])') !== null;
    if (hasContinueBtn) {
      await tryClick(page, ['button[type="submit"]', 'button[class*="continue"]', 'button[class*="next"]']);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Fill password
    const passwordSelectors = [
      'input[type="password"]',
      'input[placeholder*="password" i]',
      'input[placeholder*="contraseña" i]',
      'input[name="password"]',
    ];
    const passwordTyped = await tryType(page, passwordSelectors, password);
    if (!passwordTyped) {
      return { success: false, error: "No se pudo rellenar la contraseña." };
    }

    await new Promise(r => setTimeout(r, 500));

    // Submit login form
    const submitted = await tryClick(page, [
      'button[type="submit"]',
      'button[class*="login"]',
      'button[class*="sign-in"]',
      'button[class*="submit"]',
    ]);
    if (!submitted) {
      await page.keyboard.press("Enter");
    }

    // Wait for navigation/login result
    await new Promise(r => setTimeout(r, 4000));

    // Check for OTP/verification code screen
    const currentUrl = page.url();
    const pageContent = await page.evaluate(() => document.body.innerText.toLowerCase());

    if (pageContent.includes("verification code") || pageContent.includes("código de verificación") ||
        pageContent.includes("otp") || pageContent.includes("verify your email")) {
      return { success: false, needsOtp: true, error: "Temu ha enviado un código de verificación. No se puede automatizar con 2FA activo." };
    }

    // Check for CAPTCHA
    if (pageContent.includes("captcha") || pageContent.includes("robot") || pageContent.includes("verify you are human")) {
      return { success: false, error: "Temu muestra un captcha. Inténtalo de nuevo más tarde." };
    }

    // Check for wrong credentials
    if (pageContent.includes("incorrect password") || pageContent.includes("contraseña incorrecta") ||
        pageContent.includes("wrong password") || pageContent.includes("invalid") ||
        pageContent.includes("no account") || pageContent.includes("not found")) {
      return { success: false, error: "Email o contraseña incorrectos." };
    }

    // Check if login was successful (no longer on login page)
    const newUrl = page.url();
    const stillOnLogin = newUrl.includes("login") && !newUrl.includes("?from=");

    if (stillOnLogin) {
      // Try checking if user avatar/account menu appeared
      const loggedIn = await page.$('[class*="user-avatar"], [class*="account-name"], [class*="my-account"]') !== null;
      if (!loggedIn) {
        return { success: false, error: "Login no completado. Revisa el email y contraseña." };
      }
    }

    // Capture all Temu cookies
    await page.goto("https://www.temu.com/", { waitUntil: "domcontentloaded", timeout: 15_000 });
    await new Promise(r => setTimeout(r, 1500));

    const cookies: CookieParam[] = await page.cookies("https://www.temu.com");

    if (cookies.length === 0) {
      return { success: false, error: "Login completado pero no se pudieron capturar las cookies." };
    }

    return {
      success: true,
      cookiesJson: JSON.stringify(cookies),
      userEmail: email,
    };

  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
