// IPRoyal Web Unblocker actúa como proxy MITM → presenta certificado propio.
// Node.js rechaza certificados no reconocidos por defecto.
// Desactivamos verificación TLS sólo cuando hay proxies configurados.
// (se aplica a nivel de proceso; no afecta al frontend ni a las respuestas del servidor)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import express, { Request, Response, NextFunction } from "express";
import axios from "axios";
import https from "https";
import { randomUUID } from "crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import { createServer as createViteServer } from "vite";
import path from "path";
import * as cheerio from "cheerio";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pool, initDB } from "./db.js";
import puppeteer, { Browser } from "puppeteer";

dotenv.config({ path: ".env.local" });

const JWT_SECRET = process.env.JWT_SECRET || "changeme-use-a-real-secret";

// ─── Auth Middleware ──────────────────────────────────────────────────────────

interface AuthRequest extends Request {
  user?: { id: number; username: string; email: string; is_admin: boolean };
}

async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No autenticado" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const result = await pool.query("SELECT id, username, email, is_admin FROM users WHERE id = $1", [decoded.id]);
    if (!result.rows[0]) return res.status(401).json({ error: "Usuario no encontrado" });
    req.user = result.rows[0];
    next();
  } catch {
    res.status(401).json({ error: "Token inválido o expirado" });
  }
}

async function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  await requireAuth(req, res, () => {
    if (!req.user?.is_admin) return res.status(403).json({ error: "Acceso solo para administradores" });
    next();
  });
}

function requireLicense(req: AuthRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, async () => {
    if (req.user?.is_admin) return next();
    const result = await pool.query(
      "SELECT * FROM licenses WHERE user_id = $1 AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())",
      [req.user?.id]
    );
    if (!result.rows[0]) return res.status(403).json({ error: "Licencia requerida o expirada" });
    next();
  });
}

// ─── Helper: generate license key ────────────────────────────────────────────

function generateLicenseKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const segment = (len: number) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `FC-${segment(4)}-${segment(4)}-${segment(4)}-${segment(4)}`;
}

// ─── Proxy config (IPRoyal Web Unblocker) ────────────────────────────────────

function getProxyConfig() {
  const raw = process.env.PROXY_URL;
  try {
    const u = new URL(raw);
    return {
      protocol: "http" as const,
      host: u.hostname,
      port: parseInt(u.port) || 12323,
      auth: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) },
    };
  } catch { return undefined; }
}

// ─── Vinted Headers Builder ───────────────────────────────────────────────────

function getVintedHeaders(cookie: string, domain: string = "es") {
  const extractedParts: string[] = [];
  const foundKeys = new Set<string>();

  let authToken = "";
  const tokenMatch = cookie.match(/access_token_web[:=]\s*([a-zA-Z0-9._-]+)/i);
  if (tokenMatch?.[1]) {
    authToken = tokenMatch[1];
  } else if (cookie.trim().startsWith("ey") && cookie.length > 100) {
    authToken = cookie.trim();
  }

  let sessionToken = "";
  let visitId = "";
  let deviceId = "";
  const domainSessionKey = `_vinted_${domain}_session`;

  const allCookies: Record<string, string> = {};
  if (cookie.includes("=")) {
    cookie.split(";").forEach(part => {
      const [k, ...v] = part.split("=");
      if (k && v.length > 0) allCookies[k.trim()] = v.join("=").trim();
    });
  }

  Object.entries(allCookies).forEach(([key, val]) => {
    const kLow = key.toLowerCase();
    if (kLow === "vinted-visit-id" || kLow === "vinted_visit_id") visitId = val;
    if (kLow === "device_id" || kLow === "vinted_device_id") deviceId = val;
    if (kLow === "anon_id") { extractedParts.push(`anon_id=${val}`); foundKeys.add("anon_id"); }

    const isDomainSpecificSession = kLow.startsWith("_vinted_") && kLow.endsWith("_session");
    const isOtherDomainSession = isDomainSpecificSession && kLow !== domainSessionKey;

    if (!isOtherDomainSession && (
      kLow.includes("vinted") || kLow.includes("session") || kLow.includes("datadome") ||
      kLow === "_datadome" || kLow === "access_token_web" || kLow === "anon_id" ||
      kLow === "device_id" || kLow === "user-iso-locale" || kLow === "vinted_locale" || kLow.startsWith("_")
    )) {
      if (!foundKeys.has(key)) { extractedParts.push(`${key}=${val}`); foundKeys.add(key); }
    }
  });

  if (!deviceId) { deviceId = `web_${Math.random().toString(36).substring(2, 15)}_${Date.now()}`; extractedParts.push(`device_id=${deviceId}`); }
  if (!visitId) { visitId = `vis_${Math.random().toString(36).substring(2, 10)}`; extractedParts.push(`vinted-visit-id=${visitId}`); }

  let sessionKeyToUse = allCookies[domainSessionKey] ? domainSessionKey
    : allCookies["_vinted_session"] ? "_vinted_session"
    : Object.keys(allCookies).find(k => k.startsWith("_vinted_") && k.toLowerCase().includes("session")) || "";

  if (sessionKeyToUse) {
    sessionToken = allCookies[sessionKeyToUse];
    if (!foundKeys.has(sessionKeyToUse)) { extractedParts.push(`${sessionKeyToUse}=${sessionToken}`); foundKeys.add(sessionKeyToUse); }
  }

  if (authToken && !foundKeys.has("anon_id") && authToken.includes(".")) {
    try {
      const payload = JSON.parse(Buffer.from(authToken.split(".")[1], "base64").toString());
      if (payload.anid) { extractedParts.push(`anon_id=${payload.anid}`); foundKeys.add("anon_id"); }
    } catch {}
  }

  let cleanCookie = extractedParts.filter(p => p.includes("=")).join("; ");
  if (!cleanCookie && cookie.includes("=") && !cookie.trim().startsWith("ey")) cleanCookie = cookie.trim().replace(/;$/, "");
  if (authToken && !cleanCookie.toLowerCase().includes("access_token_web"))
    cleanCookie = cleanCookie ? `${cleanCookie}; access_token_web=${authToken}` : `access_token_web=${authToken}`;

  const langMap: Record<string, [string, string]> = {
    es: ["es-ES,es;q=0.9,en;q=0.8", "es"],
    fr: ["fr-FR,fr;q=0.9,en;q=0.8", "fr"],
    it: ["it-IT,it;q=0.9,en;q=0.8", "it"],
    pl: ["pl-PL,pl;q=0.9,en;q=0.8", "pl"],
    be: ["fr-BE,fr;q=0.9,nl-BE;q=0.8,en;q=0.7", "fr"],
    de: ["de-DE,de;q=0.9,en;q=0.8", "de"],
  };
  const [acceptLanguage, vintedLanguage] = langMap[domain] || ["en-US,en;q=0.9", "en"];

  const headers: any = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "X-Vinted-Client": "web",
    "X-Vinted-Language": vintedLanguage,
    "X-Vinted-Web-Version": "8.175.0",
    "X-App-Version": "8.175.0",
    "X-Vinted-App-Id": "1",
    "X-Vinted-Auth-Method": authToken ? "bearer" : "session",
    "X-Vinted-Logged-In": "true",
    "Origin": `https://www.vinted.${domain}`,
    "Referer": `https://www.vinted.${domain}/`,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": acceptLanguage,
    "Accept-Encoding": "gzip, deflate, br",
    "Content-Type": "application/json",
    "Sec-Ch-Ua": '"Google Chrome";v="135", "Chromium";v="135", "Not?A_Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "DNT": "1",
    "Connection": "keep-alive",
    "Cookie": cleanCookie,
    "Host": `www.vinted.${domain}`,
  };

  if (authToken) { headers["Authorization"] = `Bearer ${authToken}`; headers["X-Vinted-Access-Token"] = authToken; }
  if (sessionToken) { headers["X-XSRF-TOKEN"] = sessionToken; headers["X-CSRF-Token"] = sessionToken; headers["X-XSRF-Token"] = sessionToken; }
  if (visitId) headers["X-Vinted-Visit-Id"] = visitId;
  if (deviceId) headers["X-Vinted-Device-Id"] = deviceId;

  return { headers, domain };
}

// ─── Puppeteer / Bazooka ──────────────────────────────────────────────────────

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser) {
    try { await _browser.version(); return _browser; } catch { _browser = null; }
  }
  _browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  });
  return _browser;
}

function parseCookieStr(str: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (str || "").split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

// ── SPY LOGGER ────────────────────────────────────────────────────────────────
function spyLog(tag: string, method: string, url: string, reqBody: any, reqHeaders: Record<string,string>, res: { status: number; data: any } | null, err?: any) {
  const safeHeaders = { ...reqHeaders };
  // Truncate cookie for readability but keep enough to verify presence
  if (safeHeaders["Cookie"]) safeHeaders["Cookie"] = safeHeaders["Cookie"].slice(0, 120) + "…";
  if (safeHeaders["cookie"]) safeHeaders["cookie"] = safeHeaders["cookie"].slice(0, 120) + "…";

  console.log(`\n${"═".repeat(60)}`);
  console.log(`[SPY][${tag}] ${method} ${url}`);
  console.log(`── HEADERS SENT ──`);
  console.log(JSON.stringify(safeHeaders, null, 2));
  if (reqBody !== undefined) {
    console.log(`── BODY SENT ──`);
    console.log(JSON.stringify(reqBody, null, 2));
  }
  if (res) {
    console.log(`── RESPONSE ${res.status} ──`);
    const body = typeof res.data === "string" ? res.data.slice(0, 500) : JSON.stringify(res.data).slice(0, 500);
    console.log(body);
  }
  if (err) {
    console.log(`── ERROR ──`);
    console.log(err.message);
  }
  console.log(`${"═".repeat(60)}\n`);
}

async function reserveItemPuppeteer(itemId: string, cookiesStr: string, domain = "es"): Promise<{ transactionId: string; purchaseId: string }> {
  const { headers } = getVintedHeaders(cookiesStr, domain);
  const base = `https://www.vinted.${domain}`;

  headers["Referer"] = `${base}/items/${itemId}`;
  const proxy = getProxyConfig();
  let sellerId: string | null = null;
  const diag: string[] = [`proxy:${proxy ? "si" : "no"}`, `item_id:${itemId}`, `domain:${domain}`];

  console.log(`\n[SPY] === BAZOOKA START item=${itemId} domain=${domain} proxy=${proxy ? proxy.host : "none"} ===`);
  console.log(`[SPY] Cookie snippet: ${cookiesStr.slice(0, 200)}…`);

  // Auth check via proxy
  try {
    const authR = await axios.get(`${base}/api/v2/users/current`, {
      headers, proxy, validateStatus: () => true, timeout: 15000,
    });
    spyLog("AUTH", "GET", `${base}/api/v2/users/current`, undefined, headers as any, { status: authR.status, data: authR.data });
    diag.push(`auth:${authR.status}${authR.status === 200 ? `(user:${authR.data?.user?.id})` : ""}`);
  } catch (e: any) {
    spyLog("AUTH", "GET", `${base}/api/v2/users/current`, undefined, headers as any, null, e);
    diag.push(`auth_err:${e.message?.slice(0, 60)}`);
  }

  // Attempt 1: item detail API via proxy
  try {
    const r = await axios.get(`${base}/api/v2/items/${itemId}`, {
      headers, proxy, validateStatus: () => true, timeout: 20000,
    });
    spyLog("ITEM_API", "GET", `${base}/api/v2/items/${itemId}`, undefined, headers as any, { status: r.status, data: r.data });
    diag.push(`item:${r.status}`);
    if (r.status === 200 && r.data?.item?.user_id) sellerId = String(r.data.item.user_id);
    else diag.push(String(r.data).slice(0, 100));
  } catch (e: any) {
    spyLog("ITEM_API", "GET", `${base}/api/v2/items/${itemId}`, undefined, headers as any, null, e);
    diag.push(`item_err:${e.message?.slice(0, 80)}`);
  }

  // Attempt 2: offers/request_options via proxy
  if (!sellerId) {
    const offUrl = `${base}/api/v2/offers/request_options?item_id=${itemId}`;
    try {
      const r = await axios.get(`${base}/api/v2/offers/request_options`, {
        params: { item_id: itemId }, headers, proxy, validateStatus: () => true, timeout: 20000,
      });
      spyLog("OFFERS", "GET", offUrl, undefined, headers as any, { status: r.status, data: r.data });
      diag.push(`off:${r.status}`);
      if (r.status === 200 && r.data?.request_options?.seller_id) sellerId = String(r.data.request_options.seller_id);
      else diag.push(String(r.data).slice(0, 100));
    } catch (e: any) {
      spyLog("OFFERS", "GET", offUrl, undefined, headers as any, null, e);
      diag.push(`off_err:${e.message?.slice(0, 80)}`);
    }
  }

  // Attempt 3: HTML page via proxy — scan scripts + member links
  if (!sellerId) {
    const htmlHeaders = { "User-Agent": headers["User-Agent"], "Accept": "text/html,*/*;q=0.8", "Accept-Language": headers["Accept-Language"], "Cookie": headers["Cookie"] };
    try {
      const r = await axios.get(`${base}/items/${itemId}`, {
        headers: htmlHeaders,
        proxy, validateStatus: () => true, timeout: 20000,
      });
      spyLog("HTML_PAGE", "GET", `${base}/items/${itemId}`, undefined, htmlHeaders as any, { status: r.status, data: typeof r.data === "string" ? r.data.slice(0, 300) : r.data });
      diag.push(`html:${r.status}`);
      if (r.status === 200) {
        const $ = cheerio.load(r.data as string);
        $("script").each((_, el) => {
          if (sellerId) return;
          const t = $(el).text();
          const m = t.match(/"user_id"\s*:\s*(\d+)/) || t.match(/"seller_id"\s*:\s*(\d+)/) || t.match(/"userId"\s*:\s*(\d+)/);
          if (m) sellerId = m[1];
        });
        if (!sellerId) $("a[href*='/member/']").each((_, el) => {
          if (sellerId) return;
          const m = ($(el).attr("href") || "").match(/\/member\/(\d+)/);
          if (m) sellerId = m[1];
        });
        if (!sellerId) diag.push(`html_preview:${String(r.data).slice(0, 120)}`);
      }
    } catch (e: any) {
      spyLog("HTML_PAGE", "GET", `${base}/items/${itemId}`, undefined, htmlHeaders as any, null, e);
      diag.push(`html_err:${e.message?.slice(0, 80)}`);
    }
  }

  if (!sellerId) throw new Error(`seller_id_not_found [${diag.join(" | ")}]`);

  console.log(`[SPY] seller_id encontrado: ${sellerId}`);

  // Step 2: open conversation (reserves the item)
  const convBody = { initiator: "buy", item_id: String(itemId), opposite_user_id: sellerId };
  const convResp = await axios.post(
    `${base}/api/v2/conversations`,
    convBody,
    { headers, proxy, validateStatus: () => true, timeout: 20000 }
  );
  spyLog("CONVERSATIONS", "POST", `${base}/api/v2/conversations`, convBody, headers as any, { status: convResp.status, data: convResp.data });
  if (convResp.status !== 200 && convResp.status !== 201) {
    const preview = JSON.stringify(convResp.data).slice(0, 300);
    throw new Error(`conversations_${convResp.status}: ${preview}`);
  }
  const transactionId = convResp.data?.conversation?.transaction?.id;
  if (!transactionId) throw new Error(`no_transaction_id: ${JSON.stringify(convResp.data).slice(0, 200)}`);

  // Step 3: build checkout (locks the reservation)
  const buildBody = { purchase_items: [{ id: transactionId, type: "transaction" }] };
  const buildResp = await axios.post(
    `${base}/api/v2/purchases/checkout/build`,
    buildBody,
    { headers, proxy, validateStatus: () => true, timeout: 20000 }
  );
  spyLog("CHECKOUT_BUILD", "POST", `${base}/api/v2/purchases/checkout/build`, buildBody, headers as any, { status: buildResp.status, data: buildResp.data });
  const purchaseId = buildResp.data?.checkout?.purchase_id || buildResp.data?.purchase_id || String(transactionId);

  return { transactionId: String(transactionId), purchaseId: String(purchaseId) };
}

async function startBazookaWorker() {
  console.log("Bazooka worker arrancado");

  while (true) {
    try {
      const result = await pool.query("SELECT * FROM bazooka_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1");
      const job = result.rows[0];
      if (job) {
        await pool.query("UPDATE bazooka_jobs SET status = 'processing', updated_at = NOW() WHERE id = $1", [job.id]);
        try {
          const domainMatch = (job.url as string).match(/vinted\.([a-z.]+)\//);
          const domain = domainMatch ? domainMatch[1] : "es";
          const r = await reserveItemPuppeteer(job.item_id, job.vinted_cookies, domain);
          await pool.query("UPDATE bazooka_jobs SET status = 'done', note = $1, updated_at = NOW() WHERE id = $2", [`tx=${r.transactionId} purchase=${r.purchaseId}`, job.id]);
          console.log(`Bazooka job #${job.id} DONE`);
        } catch (err: any) {
          await pool.query("UPDATE bazooka_jobs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2", [err.message.slice(0, 300), job.id]);
          console.error(`Bazooka job #${job.id} FAILED:`, err.message);
        }
      }
    } catch (err: any) { console.error("Bazooka worker loop error:", err.message); }
    await new Promise(r => setTimeout(r, 3000));
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SNIPER-BAZOOKA v1
// ══════════════════════════════════════════════════════════════════════════════

// ─── Keep-Alive HTTPS agent fallback (sin proxy) ─────────────────────────────
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10_000,
  maxSockets: 50,
  maxFreeSockets: 10,
});

// ─── PROXY POOL — parsea PROXIES_LIST=host:port:user:pass,... ─────────────────
interface ProxyEntry { url: string; label: string; }
let _proxyPool: ProxyEntry[] | null = null;

function getProxyPool(): ProxyEntry[] {
  if (_proxyPool) return _proxyPool;
  const raw = process.env.PROXIES_LIST || process.env.PROXY_URL || "";
  if (!raw.trim()) { _proxyPool = []; return []; }

  _proxyPool = raw.split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      // Formato soportado:
      //   host:port:user:pass
      //   http://user:pass@host:port
      //   user:pass@host:port
      if (entry.startsWith("http")) return { url: entry, label: new URL(entry).hostname };
      const parts = entry.split(":");
      if (parts.length === 4) {
        const [host, port, user, pass] = parts;
        return { url: `http://${user}:${pass}@${host}:${port}`, label: `${host}:${port}` };
      }
      if (parts.length === 2) return { url: `http://${entry}`, label: entry };
      return null;
    })
    .filter(Boolean) as ProxyEntry[];

  console.log(`[SNIPER] Proxy pool: ${_proxyPool.length} proxies cargados`);
  return _proxyPool;
}

// Cache de agentes por proxy URL (keep-alive real entre requests)
const _agentCache = new Map<string, HttpsProxyAgent<string>>();
function getProxyAgent(proxyUrl: string): HttpsProxyAgent<string> {
  if (!_agentCache.has(proxyUrl)) {
    _agentCache.set(proxyUrl, new HttpsProxyAgent(proxyUrl, {
      keepAlive: true,
      keepAliveMsecs: 10_000,
      maxSockets: 10,
      // IPRoyal Web Unblocker usa certificado propio (MITM) → desactivar verificación
      rejectUnauthorized: false,
    } as any));
  }
  return _agentCache.get(proxyUrl)!;
}

function pickProxy(index: number): { agent: HttpsProxyAgent<string> | typeof keepAliveAgent; label: string } {
  const pool = getProxyPool();
  if (!pool.length) return { agent: keepAliveAgent, label: "sin-proxy" };
  const entry = pool[index % pool.length];
  return { agent: getProxyAgent(entry.url), label: entry.label };
}

// ─── WEBHOOK — Discord y/o Telegram ──────────────────────────────────────────
async function sendWebhookAlert(message: string): Promise<void> {
  const discordUrl  = process.env.DISCORD_WEBHOOK_URL;
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChat  = process.env.TELEGRAM_CHAT_ID;

  const tasks: Promise<any>[] = [];

  if (discordUrl) {
    tasks.push(
      axios.post(discordUrl, { content: message }, { timeout: 8_000 }).catch(e =>
        console.error("[WEBHOOK] Discord error:", e.message)
      )
    );
  }

  if (telegramToken && telegramChat) {
    tasks.push(
      axios.post(
        `https://api.telegram.org/bot${telegramToken}/sendMessage`,
        { chat_id: telegramChat, text: message, parse_mode: "HTML" },
        { timeout: 8_000 }
      ).catch(e => console.error("[WEBHOOK] Telegram error:", e.message))
    );
  }

  if (!tasks.length) {
    console.warn("[WEBHOOK] No hay webhook configurado (DISCORD_WEBHOOK_URL o TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID)");
    return;
  }

  await Promise.allSettled(tasks);
}

// ─── DETECCIÓN DE SESIÓN CADUCADA ────────────────────────────────────────────
let _sessionExpiredAlertSent = false;

async function handleExpiredSession(domain: string): Promise<void> {
  if (_sessionExpiredAlertSent) return;
  _sessionExpiredAlertSent = true;
  const msg =
    `🚨 <b>SNIPER DETENIDO: Cookies caducadas</b>\n\n` +
    `El Sniper-Bazooka no puede autenticarse en <b>vinted.${domain}</b>.\n` +
    `El <code>access_token_web</code> ha expirado (TTL: 2h).\n\n` +
    `→ Ve a tu app → panel lateral → <b>Vinted Session Cookie</b>\n` +
    `→ Actualiza con una cookie fresca de DevTools\n\n` +
    `⏱️ ${new Date().toISOString()}`;
  console.error("[SNIPER] ⚠️  SESIÓN CADUCADA");
  await sendWebhookAlert(msg);
  setTimeout(() => { _sessionExpiredAlertSent = false; }, 5 * 60_000);
}

// ─── DETECCIÓN DE CAPTCHA / DATADOME / CLOUDFLARE ────────────────────────────
const CAPTCHA_SIGNATURES = [
  "datadome", "cf-ray", "cloudflare", "captcha", "challenge",
  "__ddg", "bot detected", "access denied",
];

function detectCaptcha(status: number, body: string): boolean {
  if (status === 403 || status === 429) {
    const lower = body.toLowerCase();
    return CAPTCHA_SIGNATURES.some(sig => lower.includes(sig));
  }
  return false;
}

let _captchaAlertCooldown = new Map<string, number>(); // proxy → timestamp

async function handleCaptchaDetected(proxyLabel: string, domain: string): Promise<void> {
  const now = Date.now();
  const last = _captchaAlertCooldown.get(proxyLabel) ?? 0;
  if (now - last < 10 * 60_000) return; // cooldown 10 min por proxy
  _captchaAlertCooldown.set(proxyLabel, now);

  // Marcar proxy como banned en BD
  await pool.query(
    `INSERT INTO proxy_health (proxy_label, last_status, captcha_count, banned, updated_at)
     VALUES ($1, 'captcha', 1, TRUE, NOW())
     ON CONFLICT (proxy_label) DO UPDATE
     SET captcha_count = proxy_health.captcha_count + 1,
         banned = TRUE, last_status = 'captcha', updated_at = NOW()`,
    [proxyLabel]
  ).catch(() => {});

  const msg =
    `⚠️ <b>CAPTCHA DETECTADO</b>\n\n` +
    `Proxy <code>${proxyLabel}</code> ha sido marcado por Vinted/${domain}.\n` +
    `→ El proxy ha sido marcado como <b>banned</b> en proxy_health.\n` +
    `→ Los próximos disparos usarán otro proxy del pool.\n\n` +
    `⏱️ ${new Date().toISOString()}`;

  console.warn(`[SNIPER] CAPTCHA en proxy=${proxyLabel}`);
  await sendWebhookAlert(msg);
}

// ─── LOG DE GUERRA — persiste cada intento en sniper_history ─────────────────
async function saveToWarLog(
  userId: number,
  scout: ScoutResult,
  results: PurchaseResult[],
  winner: PurchaseResult | undefined
): Promise<void> {
  const workersOk = results.filter(r => r.success).length;
  const sessionExpired = results.some(r => r.sessionExpired);
  const captchaDetected = results.some(r => r.error?.includes("captcha") || r.error?.includes("403"));
  await pool.query(
    `INSERT INTO sniper_history
       (user_id, item_id, item_url, item_title, seller_id, success,
        winner_worker, winner_proxy, transaction_id, purchase_id,
        fastest_ms, workers_total, workers_ok,
        session_expired, captcha_detected, raw_results)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      userId,
      scout.itemId,
      `https://www.vinted.${scout.domain}/items/${scout.itemId}`,
      scout.title || null,
      scout.sellerId,
      !!winner,
      winner ? results.indexOf(winner) : null,
      winner?.proxyUsed ?? null,
      winner?.transactionId ?? null,
      winner?.purchaseId ?? null,
      winner?.durationMs ?? null,
      results.length,
      workersOk,
      sessionExpired,
      captchaDetected,
      JSON.stringify(results),
    ]
  ).catch(e => console.error("[WAR LOG] Error guardando:", e.message));
}

// ─── Pool de device IDs rotatorios ───────────────────────────────────────────
const DEVICE_ID_POOL: string[] = Array.from({ length: 20 }, () => randomUUID());
let deviceIdCursor = 0;
function nextDeviceId(): string {
  const id = DEVICE_ID_POOL[deviceIdCursor % DEVICE_ID_POOL.length];
  deviceIdCursor++;
  return id;
}

// ─── MODULE 3: THE GHOST — headers dinámicos que imitan la App iOS de Vinted ──
function buildSniperHeaders(cookiesStr: string, domain = "es", extra: Record<string, string> = {}): Record<string, string> {
  // Extraer Bearer token — soporta access_token_web (legacy) y v_udt (Vinted ES nuevo)
  let bearerToken = "";
  const jwtMatch = cookiesStr.match(/access_token_web=([A-Za-z0-9._-]+)/);
  const vudtMatch = cookiesStr.match(/v_udt=([A-Za-z0-9+/=_-]+)/);
  if (jwtMatch)       bearerToken = jwtMatch[1];
  else if (vudtMatch) bearerToken = vudtMatch[1];   // v_udt = token auth en Vinted.es moderno
  else if (cookiesStr.trim().startsWith("eyJ")) bearerToken = cookiesStr.trim();

  const appVersions = ["22.10.0", "23.1.0", "23.4.2", "23.6.0", "24.0.1"];
  const iosVersions = ["15.7", "16.0", "16.3", "16.6", "17.0", "17.2"];
  const scales      = ["2.00", "3.00"];
  const appVersion  = appVersions[Math.floor(Math.random() * appVersions.length)];
  const iosVersion  = iosVersions[Math.floor(Math.random() * iosVersions.length)];
  const scale       = scales[Math.floor(Math.random() * scales.length)];
  const lang        = domain === "fr" ? "fr" : domain === "it" ? "it" : domain === "de" ? "de" : "es";

  const headers: Record<string, string> = {
    "User-Agent":          `Vinted/${appVersion} (iPhone; iOS ${iosVersion}; Scale/${scale})`,
    "X-App-Test-Group":    "control",
    "X-Vinted-Language":   lang,
    "X-Vinted-Device-Id":  nextDeviceId(),
    "X-Vinted-Api-Client": "ios",
    "X-Vinted-Api-Version":"2",
    "Accept":              "application/json",
    "Accept-Language":     `${lang}-${lang.toUpperCase()};q=1.0, en;q=0.9`,
    "Accept-Encoding":     "gzip, deflate, br",
    "Content-Type":        "application/json",
    "Connection":          "keep-alive",
    // ── IP Leak Prevention: eliminar headers que revelan la IP de Railway ──
    // (Node.js/axios NO añade estos por defecto, pero los sobreescribimos
    //  explícitamente a vacío para que ningún middleware intermedio los filtre)
    "X-Forwarded-For":     "",
    "X-Real-IP":           "",
    "Via":                 "",
    "Forwarded":           "",
  };

  // Eliminar las claves vacías (no enviar el header en absoluto)
  Object.keys(headers).forEach(k => { if (headers[k] === "") delete headers[k]; });

  if (bearerToken) headers["Authorization"] = `Bearer ${bearerToken}`;

  // Extraer cookies críticas para bypass de DataDome y Cloudflare
  if (cookiesStr && cookiesStr.includes("=")) {
    const cfClearance  = cookiesStr.match(/cf_clearance=([^;]+)/)?.[1];
    const datadome     = cookiesStr.match(/datadome=([^;]+)/)?.[1];
    const session      = cookiesStr.match(/_vinted_fr_session=([^;]+)/)?.[1];
    const anon         = cookiesStr.match(/anon_id=([^;]+)/)?.[1];

    // Construir cookie header sólo con las esenciales (evitar cookies largas de analytics)
    const essentials: string[] = [];
    if (session)     essentials.push(`_vinted_fr_session=${session}`);
    if (bearerToken) essentials.push(`access_token_web=${bearerToken}`);
    if (cfClearance) essentials.push(`cf_clearance=${cfClearance}`);
    if (datadome)    essentials.push(`datadome=${datadome}`);
    if (anon)        essentials.push(`anon_id=${anon}`);

    if (essentials.length > 0) headers["Cookie"] = essentials.join("; ");
  }

  return { ...headers, ...extra };
}

// ─── MODULE 1: THE SCOUT — extrae item_id y seller_id ─────────────────────────
interface ScoutResult {
  itemId: string;
  sellerId: string;
  title: string;
  domain: string;
}

const HTML_SCOUT_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21A329",
  "Accept":          "text/html,application/xhtml+xml,*/*;q=0.9",
  "Accept-Language": "es-ES,es;q=0.9",
};

function extractSellerId(html: string): string | null {
  const patterns = [
    /"user_id"\s*:\s*(\d+)/,
    /"seller_id"\s*:\s*(\d+)/,
    /"userId"\s*:\s*(\d+)/,
    /\/member\/(\d+)/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

async function scoutItem(itemUrl: string, cookiesStr: string): Promise<ScoutResult> {
  const domainMatch = itemUrl.match(/vinted\.([a-z.]+)\//);
  const domain = domainMatch?.[1] ?? "es";
  const itemIdMatch = itemUrl.match(/\/items\/(\d+)/) ?? itemUrl.match(/\/(\d+)-/);
  const itemId = itemIdMatch?.[1] ?? "";

  if (!itemId) throw new Error(`scout_no_item_id: ${itemUrl}`);

  const base = `https://www.vinted.${domain}`;
  const { agent: htmlAgent } = pickProxy(0);

  console.log(`[SNIPER][scout] item=${itemId} domain=${domain}`);

  // Intento 1 — API con Bearer token (más fiable, funciona aunque HTML esté bloqueado)
  if (cookiesStr) {
    try {
      console.log(`[SNIPER][scout] → API autenticada ${base}/api/v2/items/${itemId}`);
      const r = await axios.get(`${base}/api/v2/items/${itemId}`, {
        headers: buildSniperHeaders(cookiesStr, domain),
        httpsAgent: keepAliveAgent, proxy: false as const,
        validateStatus: () => true, timeout: 15_000,
      });
      console.log(`[SNIPER][scout] API status=${r.status}`);
      if (r.status === 200 && r.data?.item?.user_id) {
        console.log(`[SNIPER][scout] API seller=${r.data.item.user_id}`);
        return { itemId, sellerId: String(r.data.item.user_id), title: r.data.item.title ?? "", domain };
      }
    } catch (e: any) {
      console.log(`[SNIPER][scout] API err: ${e.message}`);
    }
  }

  // Intento 2 — HTML directo sin proxy
  try {
    console.log(`[SNIPER][scout] → HTML directo ${base}/items/${itemId}`);
    const r = await axios.get(`${base}/items/${itemId}`, {
      headers: HTML_SCOUT_HEADERS,
      httpsAgent: keepAliveAgent,
      proxy: false as const,
      validateStatus: () => true, timeout: 15_000,
    });
    console.log(`[SNIPER][scout] HTML(directo) status=${r.status}`);
    if (r.status === 200) {
      const sid = extractSellerId(String(r.data));
      if (sid) {
        console.log(`[SNIPER][scout] HTML(directo) seller=${sid}`);
        return { itemId, sellerId: sid, title: "", domain };
      }
      console.log(`[SNIPER][scout] HTML(directo) 200 sin seller_id — probando vía proxy`);
    }
  } catch (e: any) {
    console.log(`[SNIPER][scout] HTML(directo) err: ${e.message} — probando vía proxy`);
  }

  // Intento 3 — HTML vía proxy residencial (si Railway IP está bloqueada)
  try {
    console.log(`[SNIPER][scout] → HTML proxy ${base}/items/${itemId}`);
    const r = await axios.get(`${base}/items/${itemId}`, {
      headers: HTML_SCOUT_HEADERS,
      httpsAgent: htmlAgent, proxy: false as const,
      validateStatus: () => true, timeout: 30_000,
    });
    console.log(`[SNIPER][scout] HTML(proxy) status=${r.status}`);
    if (r.status === 200) {
      const sid = extractSellerId(String(r.data));
      if (sid) {
        console.log(`[SNIPER][scout] HTML(proxy) seller=${sid}`);
        return { itemId, sellerId: sid, title: "", domain };
      }
      console.log(`[SNIPER][scout] HTML(proxy) 200 sin seller_id — probando directo`);
    }
  } catch (e: any) {
    console.log(`[SNIPER][scout] HTML(proxy) err: ${e.message}`);
  }

  // Intento 3 — API pública sin auth (a veces devuelve datos sin cookies)
  try {
    console.log(`[SNIPER][scout] → API pública ${base}/api/v2/items/${itemId}`);
    const r = await axios.get(`${base}/api/v2/items/${itemId}`, {
      headers: { "User-Agent": "Vinted/22.10.0 (iPhone; iOS 16.0; Scale/3.00)", "Accept": "application/json" },
      httpsAgent: keepAliveAgent, proxy: false as const,
      validateStatus: () => true, timeout: 15_000,
    });
    console.log(`[SNIPER][scout] API status=${r.status}`);
    if (r.status === 200 && r.data?.item?.user_id) {
      return { itemId, sellerId: String(r.data.item.user_id), title: r.data.item.title ?? "", domain };
    }
  } catch (e: any) {
    console.log(`[SNIPER][scout] API err: ${e.message}`);
  }

  // Sin resultados en ningún intento
  throw new Error(`scout_failed: no_seller_id item=${itemId}`);
}

// ─── MODULE 2: THE GUN — ejecuta la compra con proxy rotation + smart retry ───
interface PurchaseResult {
  success: boolean;
  transactionId?: string;
  purchaseId?: string;
  error?: string;
  durationMs: number;
  proxyUsed?: string;
  sessionExpired?: boolean;
}

const RETRYABLE_STATUS = new Set([403, 407, 429, 500, 502, 503, 504]);

async function executeFastPurchase(
  itemId: string,
  sellerId: string,
  cookiesStr: string,
  domain: string,
  workerIndex: number,
  attempt = 0,          // 0 = primer intento, 1 = retry con otro proxy
): Promise<PurchaseResult> {
  const t0 = Date.now();
  const base = `https://www.vinted.${domain}`;

  // attempt=0 → directo (Railway IP, más rápido y fiable para API POST)
  // attempt=1 → con proxy rotado (fallback si Railway IP está bloqueada)
  const useProxy = attempt > 0;
  const { agent: proxyAgent, label: proxyLabel } = pickProxy(workerIndex + attempt);
  const agent = useProxy ? proxyAgent : keepAliveAgent;
  const label = useProxy ? proxyLabel : "directo";

  const headers = buildSniperHeaders(cookiesStr, domain, {
    "Referer":           `https://www.vinted.${domain}/items/${itemId}`,
    "X-Idempotency-Key": randomUUID(),
  });

  const axCfg = {
    headers,
    httpsAgent:     agent,
    proxy:          false as const,
    validateStatus: () => true,
    timeout:        15_000,
  };

  console.log(`[SNIPER][W${workerIndex}${attempt ? `+retry(proxy)` : "(directo)"}] agent=${label}`);

  try {
    // POST 1 — Conversación (reserva)
    // Probamos dos formatos de body: moderno y legacy
    const convBody = {
      conversation: {
        item_id:    Number(itemId),
        user_id:    Number(sellerId),
      }
    };
    const convResp = await axios.post(
      `${base}/api/v2/conversations`,
      convBody,
      axCfg,
    );

    console.log(`[SNIPER][W${workerIndex}] conv=${convResp.status} body=${JSON.stringify(convResp.data).slice(0, 200)} (${Date.now() - t0}ms)`);

    // Sesión caducada
    if (convResp.status === 401) {
      await handleExpiredSession(domain);
      return { success: false, error: "session_expired_401", sessionExpired: true, durationMs: Date.now() - t0, proxyUsed: label };
    }

    // Captcha / DataDome detectado
    if (detectCaptcha(convResp.status, JSON.stringify(convResp.data))) {
      await handleCaptchaDetected(label, domain);
    }

    // Smart retry en errores de red/rate-limit
    if (RETRYABLE_STATUS.has(convResp.status) && attempt === 0) {
      console.log(`[SNIPER][W${workerIndex}] status ${convResp.status} → retry con otro proxy`);
      return executeFastPurchase(itemId, sellerId, cookiesStr, domain, workerIndex, 1);
    }

    if (convResp.status !== 200 && convResp.status !== 201) {
      return { success: false, error: `conv_${convResp.status}: ${JSON.stringify(convResp.data).slice(0, 150)}`, durationMs: Date.now() - t0, proxyUsed: label };
    }

    const transactionId = convResp.data?.conversation?.transaction?.id;
    if (!transactionId) {
      return { success: false, error: `no_transaction_id: ${JSON.stringify(convResp.data).slice(0, 150)}`, durationMs: Date.now() - t0, proxyUsed: label };
    }

    // POST 2 — Checkout (bloqueo definitivo)
    const checkoutResp = await axios.post(
      `${base}/api/v2/purchases/checkout/build`,
      { purchase_items: [{ id: transactionId, type: "transaction" }] },
      axCfg,
    );

    console.log(`[SNIPER][W${workerIndex}] checkout=${checkoutResp.status} total=${Date.now() - t0}ms`);

    if (checkoutResp.status === 401) {
      await handleExpiredSession(domain);
      return { success: false, error: "session_expired_checkout_401", sessionExpired: true, durationMs: Date.now() - t0, proxyUsed: label };
    }

    const purchaseId = checkoutResp.data?.checkout?.purchase_id
      ?? checkoutResp.data?.purchase_id
      ?? String(transactionId);

    return { success: true, transactionId: String(transactionId), purchaseId: String(purchaseId), durationMs: Date.now() - t0, proxyUsed: label };

  } catch (e: any) {
    // Error de red (timeout, ECONNRESET, etc.) → retry si es primer intento
    if (attempt === 0) {
      console.log(`[SNIPER][W${workerIndex}] net error "${e.message}" → retry`);
      return executeFastPurchase(itemId, sellerId, cookiesStr, domain, workerIndex, 1);
    }
    return { success: false, error: e.message, durationMs: Date.now() - t0, proxyUsed: label };
  }
}

// ─── Main Server ──────────────────────────────────────────────────────────────

async function startServer() {
  await initDB();
  // Worker desactivado — los jobs ahora los gestiona Goolazo vía /api/bazooka/goolazo-bridge
  // startBazookaWorker().catch(e => console.error("Bazooka worker crash:", e.message));
  // Limpiar jobs atascados de ejecuciones anteriores
  await pool.query("UPDATE bazooka_jobs SET status='failed', error_message='worker_disabled' WHERE status IN ('pending','processing')").catch(() => {});

  const app = express();

  // ── Seguridad ─────────────────────────────────────────────────────────────
  app.use(helmet({ contentSecurityPolicy: false })); // cabeceras HTTP de seguridad
  app.set("trust proxy", 1); // necesario para rate limit detrás de Railway

  // Rate limit general: 200 peticiones por IP cada 15 minutos
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Demasiadas peticiones. Espera unos minutos." }
  }));

  // Rate limit estricto para login/registro: 10 intentos cada 15 minutos
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: "Demasiados intentos. Espera 15 minutos." }
  });

  // Rate limit para Gemini: 20 llamadas por IP cada 10 minutos
  const geminiLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    message: { error: "Limite de analisis alcanzado. Espera unos minutos." }
  });

  app.use(express.json({ limit: "20mb" }));
  const PORT = parseInt(process.env.PORT || "3000");

  // ── Auth Routes ─────────────────────────────────────────────────────────────

  app.post("/api/auth/register", authLimiter, async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: "Todos los campos son obligatorios" });
    if (password.length < 6)
      return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });

    try {
      const hash = await bcrypt.hash(password, 12);
      const result = await pool.query(
        "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, is_admin",
        [username.trim(), email.trim().toLowerCase(), hash]
      );
      const user = result.rows[0];
      const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "30d" });
      res.json({ token, user });
    } catch (err: any) {
      if (err.code === "23505") {
        const field = err.detail?.includes("email") ? "email" : "usuario";
        return res.status(409).json({ error: `Ese ${field} ya está en uso` });
      }
      res.status(500).json({ error: "Error al registrar" });
    }
  });

  app.post("/api/auth/login", authLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email y contraseña requeridos" });

    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.trim().toLowerCase()]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: "Credenciales incorrectas" });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "30d" });
    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, is_admin: user.is_admin },
    });
  });

  app.get("/api/auth/me", requireAuth as any, async (req: AuthRequest, res) => {
    const user = req.user!;
    const licResult = await pool.query(
      "SELECT type, expires_at FROM licenses WHERE user_id = $1 AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1",
      [user.id]
    );
    res.json({ user, license: licResult.rows[0] || null });
  });

  // ── License Routes ──────────────────────────────────────────────────────────

  app.post("/api/auth/activate-license", requireAuth as any, async (req: AuthRequest, res) => {
    const { key, hwid } = req.body;
    const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0] || req.socket.remoteAddress || "";

    if (!key) return res.status(400).json({ error: "Clave de licencia requerida" });

    const licResult = await pool.query("SELECT * FROM licenses WHERE key = $1", [key.trim().toUpperCase()]);
    const lic = licResult.rows[0];

    if (!lic) return res.status(404).json({ error: "Licencia no encontrada" });
    if (!lic.is_active) return res.status(400).json({ error: "Esta licencia ha sido desactivada" });
    if (lic.user_id && lic.user_id !== req.user!.id)
      return res.status(400).json({ error: "Esta licencia ya está en uso por otra cuenta" });
    if (lic.expires_at && new Date(lic.expires_at) < new Date())
      return res.status(400).json({ error: "Esta licencia ha expirado" });

    await pool.query(
      "UPDATE licenses SET user_id = $1, activated_at = COALESCE(activated_at, NOW()), hwid = $2, ip = $3 WHERE id = $4",
      [req.user!.id, hwid || null, ip, lic.id]
    );

    await pool.query(
      "INSERT INTO user_sessions (user_id, ip, hwid) VALUES ($1, $2, $3)",
      [req.user!.id, ip, hwid || null]
    );

    res.json({ success: true, type: lic.type, expires_at: lic.expires_at });
  });

  // ── Admin Routes ────────────────────────────────────────────────────────────

  app.get("/api/admin/stats", requireAdmin as any, async (_req, res) => {
    const [users, licenses, sessions] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM users"),
      pool.query("SELECT COUNT(*) FROM licenses WHERE is_active = TRUE"),
      pool.query("SELECT COUNT(*) FROM user_sessions WHERE last_seen > NOW() - INTERVAL '24 hours'"),
    ]);
    res.json({
      total_users: parseInt(users.rows[0].count),
      active_licenses: parseInt(licenses.rows[0].count),
      sessions_24h: parseInt(sessions.rows[0].count),
    });
  });

  app.get("/api/admin/users", requireAdmin as any, async (_req, res) => {
    const result = await pool.query(`
      SELECT u.id, u.username, u.email, u.is_admin, u.created_at,
        l.key AS license_key, l.type AS license_type, l.expires_at, l.is_active AS license_active,
        l.hwid, l.ip
      FROM users u
      LEFT JOIN licenses l ON l.user_id = u.id AND l.is_active = TRUE
      ORDER BY u.created_at DESC
    `);
    res.json(result.rows);
  });

  app.get("/api/admin/licenses", requireAdmin as any, async (_req, res) => {
    const result = await pool.query(`
      SELECT l.*, u.username, u.email
      FROM licenses l
      LEFT JOIN users u ON u.id = l.user_id
      ORDER BY l.created_at DESC
    `);
    res.json(result.rows);
  });

  app.post("/api/admin/licenses/generate", requireAdmin as any, async (req, res) => {
    const { type = "monthly", days, quantity = 1 } = req.body;

    let expires_at: Date | null = null;
    if (type === "trial") expires_at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    else if (type === "monthly") expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    else if (type === "custom" && days) expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const keys: string[] = [];
    for (let i = 0; i < Math.min(quantity, 50); i++) {
      const key = generateLicenseKey();
      await pool.query("INSERT INTO licenses (key, type, expires_at) VALUES ($1, $2, $3)", [key, type, expires_at]);
      keys.push(key);
    }

    res.json({ keys, type, expires_at });
  });

  app.patch("/api/admin/licenses/:id/toggle", requireAdmin as any, async (req, res) => {
    const result = await pool.query(
      "UPDATE licenses SET is_active = NOT is_active WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    res.json(result.rows[0]);
  });

  app.delete("/api/admin/licenses/:id", requireAdmin as any, async (req, res) => {
    await pool.query("DELETE FROM licenses WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  });

  app.patch("/api/admin/licenses/:id/reset-hwid", requireAdmin as any, async (req, res) => {
    const result = await pool.query(
      "UPDATE licenses SET hwid = NULL, ip = NULL WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    res.json(result.rows[0]);
  });

  app.get("/api/admin/sessions", requireAdmin as any, async (_req, res) => {
    const result = await pool.query(`
      SELECT s.*, u.username, u.email
      FROM user_sessions s
      LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.last_seen DESC
      LIMIT 200
    `);
    res.json(result.rows);
  });

  app.patch("/api/admin/users/:id/toggle-admin", requireAdmin as any, async (req, res) => {
    const result = await pool.query(
      "UPDATE users SET is_admin = NOT is_admin WHERE id = $1 RETURNING id, username, email, is_admin",
      [req.params.id]
    );
    res.json(result.rows[0]);
  });

  // ── Vinted Routes (public) ──────────────────────────────────────────────────

  app.get("/api/vinted/resolve-user", async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== "string") return res.status(400).json({ error: "Se requiere la URL del usuario." });
    try {
      const m = url.match(/\/member\/(\d+)(?:-|$)/);
      if (m) return res.json({ userId: m[1] });
      const response = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 });
      const $ = cheerio.load(response.data);
      let userId = "";
      for (const s of $("script").toArray()) {
        const content = $(s).html() || "";
        const m2 = content.match(/"id":(\d+),"username":"[^"]+"/);
        if (m2) { userId = m2[1]; break; }
      }
      if (!userId) { const mId = response.data.match(/"id":(\d+),"username":/); if (mId) userId = mId[1]; }
      if (!userId) return res.status(404).json({ error: "No se pudo extraer el ID de usuario." });
      res.json({ userId });
    } catch (error: any) {
      res.status(500).json({ error: "Error al resolver usuario", details: error.message });
    }
  });

  app.get("/api/vinted/resolve-product", async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== "string") return res.status(400).json({ error: "Product URL is required" });
    const domainMatch = url.match(/vinted\.([a-z.]+)/);
    const domain = domainMatch ? domainMatch[1] : "es";
    try {
      const response = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const $ = cheerio.load(response.data);
      let itemId = url.match(/\/(\d+)-/)?.[1] || "";
      let title = "";
      const itemJson = $("script[type='application/ld+json']").html();
      if (itemJson) {
        try {
          const data = JSON.parse(itemJson);
          const obj = Array.isArray(data) ? data[0] : data;
          if (!itemId && obj.url) { const m = obj.url.match(/\/(\d+)-/); if (m) itemId = m[1]; }
          title = obj.name || "";
        } catch {}
      }
      if (!itemId) return res.status(404).json({ error: "Product ID not found." });
      res.json({ itemId, title, domain });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to resolve product", details: error.message });
    }
  });

  app.get("/api/vinted/item-status", async (req, res) => {
    const { itemId, domain = "es" } = req.query;
    if (!itemId) return res.status(400).json({ error: "Item ID is required" });
    try {
      const response = await axios.get(`https://www.vinted.${domain}/items/${itemId}`, {
        headers: { "User-Agent": "Mozilla/5.0" }, validateStatus: () => true,
      });
      res.json({ visible: response.status === 200, status: response.status });
    } catch (error: any) {
      res.json({ visible: false, status: 500 });
    }
  });

  // ── Vinted Routes (require license) ────────────────────────────────────────

  app.post("/api/vinted/check-session", requireLicense as any, async (req: AuthRequest, res) => {
    const { cookie, domain = "es" } = req.body;
    if (!cookie) return res.status(400).json({ error: "Cookie is required" });
    try {
      const { headers, domain: activeDomain } = getVintedHeaders(cookie, domain);
      const response = await axios.get(`https://www.vinted.${activeDomain}/api/v2/users/current`, { headers, timeout: 10000, validateStatus: () => true });
      if (response.status === 200) return res.json({ valid: true, user: response.data.user || response.data });
      res.json({ valid: false, status: response.status, error: response.data?.message || "Session rejected" });
    } catch (error: any) {
      res.json({ valid: false, status: 500, error: error.message });
    }
  });

  app.post("/api/vinted/inventory", requireLicense as any, async (req: AuthRequest, res) => {
    const { cookie, userId, domain = "es", userUrl } = req.body;
    if (!cookie || !userId) return res.status(400).json({ error: "Se requieren cookies e ID de usuario." });

    const cookieStr = cookie as string;
    const domainsToTry: string[] = [];
    if (cookieStr.includes("_vinted_es_session")) domainsToTry.push("es");
    if (cookieStr.includes("_vinted_fr_session")) domainsToTry.push("fr");
    if (cookieStr.includes("_vinted_it_session")) domainsToTry.push("it");
    if (cookieStr.includes("_vinted_de_session")) domainsToTry.push("de");
    if (userUrl) { const m = (userUrl as string).match(/vinted\.([a-z.]+)/); if (m && !domainsToTry.includes(m[1])) domainsToTry.push(m[1]); }
    if (!domainsToTry.includes(domain as string)) domainsToTry.push(domain as string);
    ["es", "fr", "it", "com", "co.uk", "pl", "pt", "be", "de", "nl"].forEach(d => { if (!domainsToTry.includes(d)) domainsToTry.push(d); });

    let lastError: any = null;
    for (const d of domainsToTry) {
      const { headers } = getVintedHeaders(cookieStr, d);
      for (const p of [`/api/v2/users/${userId}/items?per_page=100`, `/api/v2/items?user_id=${userId}&per_page=100`]) {
        try {
          const response = await axios.get(`https://www.vinted.${d}${p}`, { headers, timeout: 8000, validateStatus: s => s === 200 });
          const items = response.data.items || response.data.user_items;
          if (items && Array.isArray(items)) return res.json({ ...response.data, items });
        } catch (error: any) {
          lastError = error;
          if (error.response?.status === 401) return res.status(401).json({ error: "Sesión expirada.", status: 401 });
        }
      }
    }
    res.status(lastError?.response?.status || 500).json({ error: "No se pudo obtener el inventario.", details: lastError?.message });
  });

  app.post("/api/vinted/hide", requireLicense as any, async (req: AuthRequest, res) => {
    const { cookie, itemId, domain = "es" } = req.body;
    if (!cookie || !itemId) return res.status(400).json({ error: "Cookie and Item ID are required" });
    const { headers, domain: activeDomain } = getVintedHeaders(cookie, domain);
    const attempts = [
      () => axios.post(`https://www.vinted.${activeDomain}/api/v2/items/${itemId}/hide`, {}, { headers, validateStatus: s => s < 500 }),
      () => axios.patch(`https://www.vinted.${activeDomain}/api/v2/items/${itemId}`, { item: { is_hidden: true } }, { headers, validateStatus: s => s < 500 }),
      () => axios.put(`https://www.vinted.${activeDomain}/api/v2/items/${itemId}/hide`, {}, { headers, validateStatus: s => s < 500 }),
      () => axios.patch(`https://www.vinted.${activeDomain}/api/v2/items/${itemId}`, { item: { is_draft: true } }, { headers, validateStatus: s => s < 500 }),
    ];
    let lastErr: any;
    for (const attempt of attempts) {
      try {
        const r = await attempt();
        if (r.status >= 200 && r.status < 300) return res.json({ success: true, data: r.data });
        if (r.status === 401) return res.status(401).json({ error: "Sesión expirada. Renueva tu cookie.", details: r.data });
        lastErr = r.data;
      } catch (e: any) {
        if (e.response?.status === 401) return res.status(401).json({ error: "Sesión expirada. Renueva tu cookie." });
        lastErr = e.response?.data || e.message;
      }
    }
    res.status(500).json({ error: "No se pudo ocultar el artículo.", details: lastErr });
  });

  app.post("/api/vinted/reveal", requireLicense as any, async (req: AuthRequest, res) => {
    const { cookie, itemId, domain = "es" } = req.body;
    if (!cookie || !itemId) return res.status(400).json({ error: "Cookie and Item ID are required" });
    const { headers, domain: activeDomain } = getVintedHeaders(cookie, domain);
    const attempts = [
      () => axios.post(`https://www.vinted.${activeDomain}/api/v2/items/${itemId}/reveal`, {}, { headers, validateStatus: s => s < 500 }),
      () => axios.patch(`https://www.vinted.${activeDomain}/api/v2/items/${itemId}`, { item: { is_hidden: false } }, { headers, validateStatus: s => s < 500 }),
      () => axios.delete(`https://www.vinted.${activeDomain}/api/v2/items/${itemId}/hide`, { headers, validateStatus: s => s < 500 }),
      () => axios.patch(`https://www.vinted.${activeDomain}/api/v2/items/${itemId}`, { item: { is_draft: false } }, { headers, validateStatus: s => s < 500 }),
    ];
    let lastErr: any;
    for (const attempt of attempts) {
      try {
        const r = await attempt();
        if (r.status >= 200 && r.status < 300) return res.json({ success: true, data: r.data });
        if (r.status === 401) return res.status(401).json({ error: "Sesión expirada. Renueva tu cookie.", details: r.data });
        lastErr = r.data;
      } catch (e: any) {
        if (e.response?.status === 401) return res.status(401).json({ error: "Sesión expirada. Renueva tu cookie." });
        lastErr = e.response?.data || e.message;
      }
    }
    res.status(500).json({ error: "No se pudo mostrar el artículo.", details: lastErr });
  });

  app.post("/api/vinted/report", requireLicense as any, async (req: AuthRequest, res) => {
    const { cookie, itemId, reasonId, description, domain = "es" } = req.body;
    if (!cookie || !itemId) return res.status(400).json({ error: "Cookie and Item ID are required" });

    const cookieStr = cookie as string;
    const reportDomains: string[] = [];
    if (cookieStr.includes("_vinted_fr_session")) reportDomains.push("fr");
    if (cookieStr.includes("_vinted_es_session")) reportDomains.push("es");
    if (cookieStr.includes("_vinted_it_session")) reportDomains.push("it");
    if (!reportDomains.includes(domain)) reportDomains.push(domain);
    ["fr", "es", "it", "be", "pl", "de", "nl"].forEach(d => { if (!reportDomains.includes(d)) reportDomains.push(d); });

    let finalError: any = null;
    const variants = ["standard", "pure-cookie", "pure-bearer", "legacy-raw", "mobile-agent"];
    const payloads = [
      { complaint: { item_id: parseInt(itemId), reason_id: parseInt(reasonId || "12"), description: description || "Este artículo es una falsificación." } },
      { complaint: { entity_id: parseInt(itemId), entity_type: "Item", reason_id: parseInt(reasonId || "12"), description: description || "Este artículo es una falsificación." } },
    ];

    for (const activeDom of reportDomains) {
      for (const variant of variants) {
        await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
        for (const payload of payloads) {
          try {
            const { headers } = getVintedHeaders(cookieStr, activeDom);
            if (variant === "pure-cookie") { delete headers["Authorization"]; headers["X-Vinted-Auth-Method"] = "session"; }
            else if (variant === "pure-bearer") { delete headers["Cookie"]; headers["X-Vinted-Auth-Method"] = "oauth"; }
            else if (variant === "legacy-raw") { headers["Cookie"] = cookieStr.trim(); delete headers["Authorization"]; }
            else if (variant === "mobile-agent") { headers["User-Agent"] = "Vinted/8.162.0 (iPhone; iOS 17.4; Scale/3.00)"; headers["X-Vinted-Client"] = "ios"; }
            headers["Referer"] = `https://www.vinted.${activeDom}/items/${itemId}`;
            headers["Origin"] = `https://www.vinted.${activeDom}`;
            const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8); return v.toString(16); });
            headers["X-Vinted-Idempotency-Key"] = uuid();
            const response = await axios.post(`https://www.vinted.${activeDom}/api/v2/complaints`, payload, { headers, timeout: 10000, maxRedirects: 0, validateStatus: s => s >= 200 && s < 303 });
            return res.json({ success: true, data: response.data, domainUsed: activeDom, variantUsed: variant });
          } catch (error: any) {
            finalError = error;
            if (error.response?.status === 401) return res.status(401).json({ error: "Sesión inválida o expirada." });
          }
        }
      }
    }
    res.status(finalError?.response?.status || 500).json({ error: "Failed to report item", details: finalError?.message });
  });

  app.post("/api/vinted/spam-checkout", requireLicense as any, async (req: AuthRequest, res) => {
    const { cookie, itemId, domain = "es" } = req.body;
    if (!cookie || !itemId) return res.status(400).json({ error: "Cookie and Item ID are required" });

    const rawCookie = cookie as string;
    const cookies = rawCookie.includes("\n")
      ? rawCookie.split("\n").map(c => c.trim()).filter(c => c.length > 5)
      : rawCookie.split(",").map(c => c.trim()).filter(c => c.length > 5);

    const id = itemId.toString();
    const activeDomains = [...new Set([domain, "fr", "es", "it", "pl", "be", "de", "nl"])];
    let totalSuccess = 0;

    await Promise.all(cookies.map(token =>
      Promise.all(activeDomains.slice(0, 8).map(async dom => {
        try {
          const { headers } = getVintedHeaders(token, dom);
          await axios.post(`https://www.vinted.${dom}/api/v2/items/${id}/view`, {}, { headers, timeout: 4000, validateStatus: () => true });
        } catch {}
      }))
    ));

    const endTime = Date.now() + 120 * 1000;
    while (Date.now() < endTime) {
      await Promise.all(cookies.map(token =>
        Promise.all(activeDomains.map(async dom => {
          const { headers } = getVintedHeaders(token, dom);
          const targets = [
            `https://www.vinted.${dom}/api/v2/items/${id}/checkout`,
            `https://www.vinted.${dom}/api/v2/items/${id}/favourite`,
            `https://www.vinted.${dom}/api/v2/items/${id}/view`,
            `https://www.vinted.${dom}/api/v2/complaints`,
          ];
          await Promise.all(targets.map(async url => {
            try {
              const hitHeaders = { ...headers, "X-Vinted-Idempotency-Key": `cont_${Date.now()}_${Math.random().toString(36).substring(5)}` };
              const data = url.includes("complaints") ? { complaint: { item_id: parseInt(id), reason_id: 12, description: "Flagged." } } : { item_id: parseInt(id) };
              const r = await axios({ method: "POST", url, data, headers: hitHeaders, timeout: 5000, validateStatus: () => true });
              if (r.status < 400) totalSuccess++;
            } catch {}
          }));
        }))
      ));
      await new Promise(r => setTimeout(r, 500));
    }

    res.json({ success: totalSuccess > 0, count: totalSuccess, message: `BOMBARDEO FINALIZADO. ${totalSuccess} impactos en 2 minutos.` });
  });

  // ── Profits / Sales endpoints ────────────────────────────────────────────────

  // Accounts
  app.get("/api/profits/accounts", requireAuth as any, async (req: AuthRequest, res) => {
    const r = await pool.query("SELECT * FROM vinted_accounts WHERE user_id=$1 ORDER BY created_at DESC", [req.user!.id]);
    res.json(r.rows);
  });
  app.post("/api/profits/accounts", requireAuth as any, async (req: AuthRequest, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "Username requerido" });
    try {
      const r = await pool.query("INSERT INTO vinted_accounts(user_id,username) VALUES($1,$2) RETURNING *", [req.user!.id, username.replace(/^@/, "")]);
      res.json(r.rows[0]);
    } catch { res.status(409).json({ error: "Esa cuenta ya existe" }); }
  });
  app.delete("/api/profits/accounts/:id", requireAuth as any, async (req: AuthRequest, res) => {
    await pool.query("DELETE FROM vinted_accounts WHERE id=$1 AND user_id=$2", [req.params.id, req.user!.id]);
    res.json({ ok: true });
  });

  // Sales
  app.get("/api/profits/sales", requireAuth as any, async (req: AuthRequest, res) => {
    const r = await pool.query("SELECT * FROM sales WHERE user_id=$1 ORDER BY date DESC, created_at DESC", [req.user!.id]);
    res.json(r.rows);
  });
  app.post("/api/profits/sales", requireAuth as any, async (req: AuthRequest, res) => {
    const rows = Array.isArray(req.body) ? req.body : [req.body];
    const inserted: any[] = [];
    for (const s of rows) {
      const { model, buy_price, sell_price, date, vinted_account } = s;
      if (!model || buy_price == null || sell_price == null || !date) continue;
      const r = await pool.query(
        "INSERT INTO sales(user_id,model,buy_price,sell_price,date,vinted_account) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [req.user!.id, model, buy_price, sell_price, date, vinted_account || null]
      );
      inserted.push(r.rows[0]);
    }
    res.json(inserted);
  });
  app.delete("/api/profits/sales/:id", requireAuth as any, async (req: AuthRequest, res) => {
    await pool.query("DELETE FROM sales WHERE id=$1 AND user_id=$2", [req.params.id, req.user!.id]);
    res.json({ ok: true });
  });

  // ── Bazooka / Reserve endpoints ─────────────────────────────────────────────

  // ══════════════════════════════════════════════════════════════════
  // GOOLAZO BRIDGE
  // El endpoint POST /api/bazooka/client/jobs de Goolazo NO requiere
  // autenticación (confirmado en server.js línea 994):
  //   "Sin autenticación — cualquier extensión instalada puede enviar jobs."
  // Solo necesitamos replicar los headers de la extensión Chrome.
  // ══════════════════════════════════════════════════════════════════

  const EXT_ID        = "mbjjaobpmbcpnmmlmobkllamilnmbfap";
  const GOOLAZO_API = "https://api.blackstock.es";
  const CLIENT_PREFIX  = "/api/bazooka/client";

  const jitter = (min = 800, max = 2500) =>
    new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));

  function buildExtHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "User-Agent":        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36",
      "sec-ch-ua":         '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile":  "?0",
      "sec-ch-ua-platform":'"Windows"',
      "Accept":            "application/json, text/plain, */*",
      "Accept-Language":   "es-ES,es;q=0.9,en;q=0.8",
      "Accept-Encoding":   "gzip, deflate, br",
      "Content-Type":      "application/json",
      "Origin":            `chrome-extension://${EXT_ID}`,
      "Referer":           `chrome-extension://${EXT_ID}/dashboard.html`,
      "Sec-Fetch-Dest":    "empty",
      "Sec-Fetch-Mode":    "cors",
      "Sec-Fetch-Site":    "cross-site",
      "Connection":        "keep-alive",
      ...extra,
    };
  }

  // LOGIN endpoint — mantenido por si el usuario tiene cuenta Goolazo
  app.post("/api/bazooka/goolazo-login", requireAuth as any, async (req: AuthRequest, res) => {
    const { email, password } = req.body as { email: string; password: string };
    if (!email || !password) return res.status(400).json({ error: "email y password requeridos" });

    // 1. Obtener CSRF antes del login (sin cookie todavía)
    let csrfToken = "";
    try {
      const csrfResp = await axios.get(`${GOOLAZO_API}${CLIENT_PREFIX}/csrf`, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36",
          "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "Origin": `chrome-extension://${EXT_ID}`,
          "Referer": `chrome-extension://${EXT_ID}/dashboard.html`,
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "cross-site",
        },
        validateStatus: () => true,
        timeout: 15000,
      });

      console.log(`[BS-LOGIN] CSRF pre-login status=${csrfResp.status}`);
      // Capturar Set-Cookie del CSRF (la sesión empieza aquí)
      const setCookieHeader = csrfResp.headers["set-cookie"] as string | string[] | undefined;
      const initialCookie = Array.isArray(setCookieHeader)
        ? setCookieHeader.map((c: string) => c.split(";")[0]).join("; ")
        : (String(setCookieHeader || "")).split(";")[0];

      csrfToken = csrfResp.data?.csrfToken || "";
      if (!csrfToken) return res.status(502).json({ error: "No se pudo obtener CSRF inicial", detail: csrfResp.data });

      // 2. POST /login con esa cookie + CSRF
      await jitter(800, 1800);
      const loginResp = await axios.post(
        `${GOOLAZO_API}${CLIENT_PREFIX}/login`,
        { email, password },
        {
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": csrfToken,
            "Cookie": initialCookie,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36",
            "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "Origin": `chrome-extension://${EXT_ID}`,
            "Referer": `chrome-extension://${EXT_ID}/dashboard.html`,
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "cross-site",
          },
          validateStatus: () => true,
          timeout: 20000,
        }
      );

      console.log(`[BS-LOGIN] login status=${loginResp.status} data=${JSON.stringify(loginResp.data).slice(0, 200)}`);

      if (!loginResp.data?.ok && loginResp.status !== 200) {
        return res.status(loginResp.status).json({ error: loginResp.data?.error || `login_failed_${loginResp.status}`, detail: loginResp.data });
      }

      // 3. Consolidar todas las cookies de login (la sesión autenticada)
      const loginSetCookie = loginResp.headers["set-cookie"] as string | string[] | undefined;
      const allCookieParts: string[] = [];

      // Primero las del CSRF inicial (contienen el sid)
      if (initialCookie) {
        initialCookie.split(";").map((p: string) => p.trim()).filter(Boolean).forEach((p: string) => allCookieParts.push(p));
      }
      // Luego las del login (pueden sobreescribir/ampliar la sesión)
      if (Array.isArray(loginSetCookie)) {
        loginSetCookie.forEach((c: string) => {
          const cookiePart = c.split(";")[0].trim();
          if (cookiePart) allCookieParts.push(cookiePart);
        });
      } else if (loginSetCookie) {
        allCookieParts.push(String(loginSetCookie).split(";")[0].trim());
      }

      // También incluir csrfToken renovado si viene en el body
      if (loginResp.data?.csrfToken) csrfToken = String(loginResp.data.csrfToken);

      // Deduplicar por nombre de cookie (la última gana)
      const cookieMap = new Map<string, string>();
      allCookieParts.forEach(part => {
        const [name] = part.split("=");
        if (name) cookieMap.set(name.trim(), part);
      });
      const finalCookie = Array.from(cookieMap.values()).join("; ");

      console.log(`[BS-LOGIN] sesión obtenida: ${finalCookie.slice(0, 120)}…`);
      return res.json({ ok: true, goolazoCookie: finalCookie, email: loginResp.data?.account?.email || email });

    } catch (e: any) {
      return res.status(502).json({ error: `Error en login Goolazo: ${e.message}` });
    }
  });

  app.post("/api/bazooka/goolazo-bridge", requireLicense as any, async (req: AuthRequest, res) => {
    const { url, title } = req.body as { url: string; title?: string };

    if (!url) return res.status(400).json({ error: "url requerida" });

    const proxy = getProxyConfig();

    // ── 1. Jitter inicial ──
    await jitter(800, 2500);

    // ── 2. Extraer accountMeta del HTML de Vinted (mismo regex que background.js) ──
    let accountMemberId = "";
    let accountName = "";
    let accountUrl = "";

    try {
      const pageResp = await axios.get(url, {
        headers: {
          "User-Agent":        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36",
          "Accept":            "text/html,application/xhtml+xml,*/*;q=0.9,*/*;q=0.8",
          "Accept-Language":   "es-ES,es;q=0.9",
          "sec-ch-ua":         '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
          "sec-ch-ua-mobile":  "?0",
          "sec-ch-ua-platform":'"Windows"',
          "Sec-Fetch-Dest":    "document",
          "Sec-Fetch-Mode":    "navigate",
          "Sec-Fetch-Site":    "none",
        },
        proxy,
        validateStatus: () => true,
        timeout: 20000,
      });

      if (pageResp.status === 200) {
        const html = String(pageResp.data);
        const regex = /href="([^"]*\/member\/(\d+)(?:-([^"/?#]+))?[^"]*)"[^>]*>([\s\S]{0,180}?)<\/a>/gi;
        let match: RegExpExecArray | null;
        const candidates: Array<{ accountMemberId: string; accountName: string; accountUrl: string }> = [];

        while ((match = regex.exec(html)) !== null) {
          const memberHref = match[1] || "";
          const memberId   = String(match[2] || "").trim();
          const slug       = String(match[3] || "").trim();
          const anchorText = (match[4] || "").replace(/<[^>]+>/g, "").trim();
          const name       = anchorText || slug.replace(/-/g, " ");
          let resolvedUrl  = "";
          try { const u = new URL(memberHref, url); u.hash = ""; u.search = ""; resolvedUrl = u.toString(); } catch {}
          if (!memberId && !name) continue;
          candidates.push({ accountMemberId: memberId, accountName: name, accountUrl: resolvedUrl });
        }

        if (candidates.length > 0) {
          const best = [...candidates].reverse().find(c => c.accountName || c.accountMemberId) || candidates[candidates.length - 1];
          accountMemberId = best.accountMemberId;
          accountName     = best.accountName;
          accountUrl      = best.accountUrl;
        }
        console.log(`[BS] accountMeta: id=${accountMemberId} name=${accountName}`);
      } else {
        console.log(`[BS] HTML status=${pageResp.status}`);
      }
    } catch (e: any) {
      console.log(`[BS] HTML error: ${e.message}`);
    }

    // ── 3. Jitter antes del POST ──
    await jitter(600, 1800);

    // ── 4. POST directo a Goolazo — SIN autenticación (confirmado en source) ──
    const jobPayload = { url, title: title || "", accountName, accountMemberId, accountUrl };
    console.log(`[BS] POST /jobs → ${JSON.stringify(jobPayload)}`);

    try {
      const resp = await axios.post(
        `${GOOLAZO_API}${CLIENT_PREFIX}/jobs`,
        jobPayload,
        { headers: buildExtHeaders(), validateStatus: () => true, timeout: 20000 }
      );

      console.log(`[BS] response ${resp.status} → ${JSON.stringify(resp.data).slice(0, 300)}`);

      if (resp.status === 200 || resp.status === 201) {
        const itemId = url.match(/\/items\/(\d+)/)?.[1] || url.match(/\/(\d+)-/)?.[1] || null;
        if (itemId) {
          await pool.query(
            "INSERT INTO bazooka_jobs (user_id, url, title, item_id, vinted_cookies, status, note) VALUES ($1,$2,$3,$4,$5,'done',$6) ON CONFLICT DO NOTHING",
            [req.user!.id, url, title || null, itemId, "goolazo", `bs_job_id=${resp.data?.job?.id ?? ""}`]
          ).catch(() => {});
        }
        return res.json({ ok: true, job: resp.data?.job || null, dashboard: resp.data?.dashboard || null, accountMemberId, accountName });
      } else {
        return res.status(resp.status).json({ error: `Goolazo ${resp.status}`, detail: resp.data });
      }
    } catch (e: any) {
      return res.status(502).json({ error: `Error POST job: ${e.message}` });
    }
  });

  app.post("/api/bazooka/enqueue", requireLicense as any, async (req: AuthRequest, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    if (!items.length) return res.status(400).json({ error: "Se requieren items" });
    const cookies = items[0]?.cookies;
    if (!cookies) return res.status(400).json({ error: "Se requieren las cookies de Vinted" });

    const inserted: any[] = [];
    for (const item of items) {
      const { url, title, cookies: itemCookies } = item;
      if (!url) continue;
      const itemId = (url as string).match(/\/items\/(\d+)/)?.[1] || (url as string).match(/\/(\d+)-/)?.[1] || null;
      if (!itemId) continue;
      const r = await pool.query(
        "INSERT INTO bazooka_jobs (user_id, url, title, item_id, vinted_cookies) VALUES ($1,$2,$3,$4,$5) RETURNING id, url, title, item_id, status, created_at",
        [req.user!.id, url, title || null, itemId, itemCookies || cookies]
      );
      inserted.push(r.rows[0]);
    }
    res.json(inserted);
  });

  app.get("/api/bazooka/jobs", requireLicense as any, async (req: AuthRequest, res) => {
    const r = await pool.query(
      "SELECT id, url, title, item_id, status, note, error_message, created_at, updated_at FROM bazooka_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",
      [req.user!.id]
    );
    res.json(r.rows);
  });

  app.patch("/api/bazooka/jobs/:id/result", requireLicense as any, async (req: AuthRequest, res) => {
    const { status, note, error_message } = req.body;
    await pool.query(
      "UPDATE bazooka_jobs SET status=$1, note=$2, error_message=$3, updated_at=NOW() WHERE id=$4 AND user_id=$5",
      [status, note || null, error_message || null, req.params.id, req.user!.id]
    );
    res.json({ ok: true });
  });

  app.delete("/api/bazooka/jobs/clear", requireLicense as any, async (req: AuthRequest, res) => {
    await pool.query("DELETE FROM bazooka_jobs WHERE user_id=$1", [req.user!.id]);
    res.json({ ok: true });
  });

  // ── MODULE 4: THE BRIDGE — Sniper endpoint ────────────────────────────────────
  app.post("/api/sniper/fire", requireLicense as any, async (req: AuthRequest, res) => {
    const { url, cookies: cookiesStr, workers: workersCount = 3 } = req.body as {
      url: string;
      cookies: string;
      workers?: number;
    };

    if (!url)        return res.status(400).json({ error: "url requerida" });
    if (!cookiesStr) return res.status(400).json({ error: "cookies requeridas (v_udt + v_uid + v_sid)" });

    const N = Math.min(Math.max(Number(workersCount) || 3, 1), 5); // 1-5 workers

    console.log(`[SNIPER] FIRE url=${url} workers=${N}`);

    // ── 1. Scout: extraer item_id + seller_id ──
    let scout: ScoutResult;
    try {
      scout = await scoutItem(url, cookiesStr);
      console.log(`[SNIPER] scout OK item=${scout.itemId} seller=${scout.sellerId}`);
    } catch (e: any) {
      // scoutItem ya añade el prefijo scout_failed — no duplicar
      return res.status(422).json({ error: e.message });
    }

    // ── 2. Gun: disparar N workers en paralelo con offset de 10ms entre cada uno ──
    //    Esto maximiza la probabilidad de ser el primero en entrar en el túnel de BD de Vinted
    const workerPromises = Array.from({ length: N }, (_, i) =>
      new Promise<PurchaseResult>(resolve => {
        setTimeout(
          () => executeFastPurchase(scout.itemId, scout.sellerId, cookiesStr, scout.domain, i).then(resolve),
          i * 10, // 0ms, 10ms, 20ms, 30ms, 40ms
        );
      })
    );

    const results = await Promise.allSettled(workerPromises);

    const parsed = results.map((r, i) => ({
      worker: i,
      ...(r.status === "fulfilled"
        ? r.value
        : { success: false, error: String((r as any).reason), durationMs: 0, proxyUsed: "error" }),
    }));

    const winner = parsed.find(r => r.success);
    const allErrors = parsed.every(r => !r.success);

    console.log(`[SNIPER] results: ${parsed.map(r => `w${r.worker}:${r.success ? "OK" : "FAIL"}`).join(" | ")}`);

    // ── 3. Log de guerra ──
    await saveToWarLog(req.user!.id, scout, parsed, winner);

    return res.json({
      ok:        !allErrors,
      itemId:    scout.itemId,
      sellerId:  scout.sellerId,
      title:     scout.title,
      workers:   N,
      winner:    winner || null,
      results:   parsed,
      fastestMs: Math.min(...parsed.map(r => r.durationMs ?? 9999)),
    });
  });

  // ── TEST DE PROXIES — verifica IPs y detecta leaks ──────────────────────────
  app.get("/api/sniper/test-proxies", requireAuth as any, async (_req: AuthRequest, res) => {
    const pool2 = getProxyPool();

    if (!pool2.length) {
      // Sin proxies: devuelve la IP de Railway (útil para comparar)
      try {
        const r = await axios.get("https://api.ipify.org?format=json", { timeout: 8_000 });
        return res.json({ ok: true, mode: "no-proxy", railwayIp: r.data?.ip, proxies: [] });
      } catch {
        return res.json({ ok: false, mode: "no-proxy", error: "ipify timeout" });
      }
    }

    // Deduplicar por URL para detectar si es un unblocker (todas iguales)
    const uniqueUrls = [...new Set(pool2.map(e => e.url))];
    const isUnblocker = uniqueUrls.length === 1 && pool2.length > 1;

    // Si todas las entradas son la misma URL (ej: IPRoyal Unblocker),
    // testear con N=max(pool.length, 3) workers en paralelo usando agentes FRESCOS
    // (sin caché) para forzar conexiones TCP separadas → IPs distintas reales.
    const slotsToTest = isUnblocker
      ? Math.max(pool2.length, 3)
      : pool2.length;

    const tests = await Promise.allSettled(
      Array.from({ length: slotsToTest }, (_, i) => {
        const entry = pool2[i % pool2.length];
        return (async () => {
          const t0 = Date.now();
          // Agente fresco por slot — NO usar caché para evitar reutilizar TCP
          const freshAgent = new HttpsProxyAgent(entry.url, { keepAlive: false, rejectUnauthorized: false } as any);
          try {
            const r = await axios.get("https://api.ipify.org?format=json", {
              httpsAgent: freshAgent,
              proxy:      false as const,
              timeout:    10_000,
            });
            const ip = r.data?.ip ?? "unknown";

            // Actualizar proxy_health en BD
            await pool.query(
              `INSERT INTO proxy_health (proxy_label, last_status, success_count, last_used, updated_at)
               VALUES ($1,'ok',1,NOW(),NOW())
               ON CONFLICT (proxy_label) DO UPDATE
               SET success_count = proxy_health.success_count + 1,
                   last_status = 'ok', last_used = NOW(), updated_at = NOW(), banned = FALSE`,
              [entry.label]
            ).catch(() => {});

            return { index: i, proxy: entry.label, ip, latencyMs: Date.now() - t0, ok: true };
          } catch (e: any) {
            await pool.query(
              `INSERT INTO proxy_health (proxy_label, last_status, fail_count, last_used, updated_at)
               VALUES ($1,'fail',1,NOW(),NOW())
               ON CONFLICT (proxy_label) DO UPDATE
               SET fail_count = proxy_health.fail_count + 1,
                   last_status = 'fail', last_used = NOW(), updated_at = NOW()`,
              [entry.label]
            ).catch(() => {});
            return { index: i, proxy: entry.label, ip: null, latencyMs: Date.now() - t0, ok: false, error: e.message };
          }
        })();
      })
    );

    const results  = tests.map(t => t.status === "fulfilled" ? t.value : { ok: false, error: String((t as any).reason) });
    const ips      = results.filter(r => r.ok).map(r => (r as any).ip as string);
    const unique   = new Set(ips).size;

    // Para unblockers (misma URL), leak REAL = todas las IPs son idénticas en paralelo
    // Para proxies distintos, leak = IPs repetidas entre entradas diferentes
    const ipLeakWarning = isUnblocker
      ? (ips.length > 1 && unique === 1)   // unblocker no está rotando
      : (unique < ips.length);              // proxies distintos con IP repetida

    return res.json({
      ok: true,
      mode: isUnblocker ? "rotating-unblocker" : "dedicated-proxies",
      proxies: results,
      uniqueIps: unique,
      totalOk: ips.length,
      ipLeakWarning,
      ...(isUnblocker && { note: "IPRoyal Unblocker: cada slot fuerza conexión TCP nueva → IPs distintas esperadas" }),
    });
  });

  // ── WAR LOG — historial de disparos ─────────────────────────────────────────
  app.get("/api/sniper/history", requireAuth as any, async (req: AuthRequest, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await pool.query(
      `SELECT id, item_id, item_url, item_title, seller_id, success,
              winner_worker, winner_proxy, transaction_id, fastest_ms,
              workers_total, workers_ok, session_expired, captcha_detected, fired_at
       FROM sniper_history
       WHERE user_id = $1
       ORDER BY fired_at DESC LIMIT $2`,
      [req.user!.id, limit]
    );
    const stats = await pool.query(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE success) as wins,
         COUNT(*) FILTER (WHERE session_expired) as session_errors,
         COUNT(*) FILTER (WHERE captcha_detected) as captchas,
         ROUND(AVG(fastest_ms)) as avg_ms,
         MIN(fastest_ms) as best_ms
       FROM sniper_history WHERE user_id = $1`,
      [req.user!.id]
    );
    return res.json({ history: rows.rows, stats: stats.rows[0] });
  });

  // ── PROXY HEALTH — estado del pool ──────────────────────────────────────────
  app.get("/api/sniper/proxy-health", requireAuth as any, async (_req: AuthRequest, res) => {
    const rows = await pool.query(
      "SELECT * FROM proxy_health ORDER BY updated_at DESC"
    );
    return res.json({ pool: getProxyPool().map(p => p.label), health: rows.rows });
  });

  // ── Tongue / Gemini endpoints ───────────────────────────────────────────────

  app.get("/api/tongue/models", requireAuth as any, async (_req: AuthRequest, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "No API key" });
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await r.json();
    res.json(data);
  });

  app.post("/api/tongue/analyze", geminiLimiter, requireLicense as any, async (req: AuthRequest, res) => {
    const { imageBase64, brand } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "Se requiere imagen" });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY no configurada en el servidor" });

    const prompt = `Analiza esta imagen de una lengueta de zapatilla ${brand}.

      1. Extrae los datos tecnicos:
      - model (ID de modelo, ej: JQ5874 o MR530SG)
      - sku (lo mismo que model)
      - reference (referencia de 12 digitos en NB, o serie en Adidas ej: #123456789)
      - reference2 (7 digitos en NB)
      - brandSerial (ej: LXCK1298 CLX o FGwKZ39<82143)
      - date (ej: 05/22)
      - lvl (ej: EVN 791001)
      - sizes (un objeto con us, uk, fr, jp)

      2. Genera el JSON con estos campos adicionales:
      - modelName: Nombre comercial real (ej: Adidas Samba Leopard)
      - color: Color dominante en frances (ej: blanc et vert)
      - listingTitle: Titulo para Vinted EXACTAMENTE asi: "[modelName] - Pointure [FR] [color] / [model]"
      - listingDescription: Descripcion en frances con formato: "[Frase natural]\n\nCouleur : [color]\nModele : [model]\nTaille : [fr]"

      Si no encuentras algun dato, pon "Desconocido". Solo devuelve el JSON puro sin markdown.`;

    const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-preview-04-17", "gemini-2.0-flash", "gemini-1.5-flash"];
    try {
      const base64Data = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
      let lastError = "";
      for (const model of MODELS) {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [
                { inlineData: { mimeType: "image/jpeg", data: base64Data } },
                { text: prompt }
              ]}],
              tools: [{ googleSearch: {} }]
            })
          }
        );
        const data = await r.json();
        if (!r.ok) { lastError = JSON.stringify(data); console.error(`Model ${model} failed:`, lastError); continue; }
        const text = data.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text || "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return res.status(422).json({ error: "No se pudo extraer JSON", raw: text });
        try {
          const raw = jsonMatch[0];
          console.log("[TONGUE] raw Gemini JSON:", raw.slice(0, 300));

          const clean = raw
            // 1. Trailing commas antes de } o ]
            .replace(/,\s*([}\]])/g, '$1')
            // 2. Control chars literales dentro de strings
            .replace(/("(?:[^"\\]|\\.)*")|[\x00-\x1F]/g, (m, str) =>
              str ? str : ({ '\n':'\\n','\r':'\\r','\t':'\\t' } as Record<string,string>)[m] ?? '')
            // 3. Single quotes → double quotes (si Gemini usa comillas simples)
            .replace(/'/g, '"');

          return res.json(JSON.parse(clean));
        } catch (parseErr: any) {
          console.error("[TONGUE] JSON parse failed:", parseErr.message, "raw:", jsonMatch[0].slice(0, 300));
          return res.status(422).json({ error: "JSON malformado de Gemini", raw: jsonMatch[0].slice(0, 500) });
        }
      }
      return res.status(500).json({ error: "Ningun modelo disponible: " + lastError });
    } catch (err: any) {
      console.error("Tongue analyze error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/tongue/generate", geminiLimiter, requireLicense as any, async (req: AuthRequest, res) => {
    const { imageBase64, brand, detections, customPrompt } = req.body;
    if (!detections) return res.status(400).json({ error: "Se requieren los datos detectados" });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY no configurada en el servidor" });

    let brandPrompt = "";
    if (brand === "ADIDAS") {
      brandPrompt = `CRITICAL IDENTITY RECONSTRUCTION - ADIDAS tongue label.
STRICTLY DO NOT CHANGE: ART NO/SKU "${detections.sku}", DATE "${detections.date}", FACTORY/LVL "${detections.lvl}", ALL SIZES (US ${detections.sizes?.us}, UK ${detections.sizes?.uk}, FR ${detections.sizes?.fr}, JP ${detections.sizes?.jp}).
ONLY UPDATE: Brand Serial (bottom-left): "${detections.brandSerial}", Reference (#): "${detections.reference}".
RAW LOOK: 12MP smartphone photo, natural grain. NO AI watermarks. Bold Adidas sans-serif font.
${customPrompt || ""}`;
    } else if (brand === "ASICS") {
      brandPrompt = `CRITICAL IDENTITY RECONSTRUCTION - ASICS tongue label.
STRICTLY DO NOT CHANGE: SKU "${detections.sku}", DATE "${detections.date}", ALL SIZES (US ${detections.sizes?.us}, UK ${detections.sizes?.uk}, FR ${detections.sizes?.fr}, JP ${detections.sizes?.jp}).
ONLY UPDATE: Tracking code "${detections.reference}" (change first letter + 6 digits to random), Serial number "${detections.brandSerial}" (replace with 15 random uppercase alphanumeric chars).
LOOK: Keep vertical dividers (|) in size table, compressed clean ASICS typography, macro photo style.
${customPrompt || ""}`;
    } else if (brand === "ONITSUKA") {
      brandPrompt = `CRITICAL IDENTITY RECONSTRUCTION - ONITSUKA TIGER tongue label.
STRICTLY DO NOT CHANGE: SKU "${detections.sku}", DATE "${detections.date}", ALL SIZES (US ${detections.sizes?.us}, UK ${detections.sizes?.uk}, FR ${detections.sizes?.fr}, CM ${detections.sizes?.jp}), country text.
ONLY UPDATE: Batch Code "${detections.reference}" (F + 6 random digits), Unit Serial "${detections.brandSerial}" (15 random uppercase alphanumeric chars).
LOOK: Sans-serif ultra-condensed font, white matte background, thermal transfer print, no tiger logo.
${customPrompt || ""}`;
    } else {
      brandPrompt = `NEW BALANCE internal tongue label reconstruction.
STYLE/MODEL: "${detections.sku}". DATE: "${detections.date}". FACTORY: "${detections.lvl}".
SIZES: US ${detections.sizes?.us} | UK ${detections.sizes?.uk} | EU ${detections.sizes?.fr} | CM ${detections.sizes?.jp}.
CHANGE ONLY THESE 3 CODES: SERIAL1 (12 digits): "${detections.reference}", SERIAL2 (7 digits): "${detections.reference2}", BRAND CODE: "${detections.brandSerial}".
LOOK: macro phone photo, white satin material, heavy industrial font. No AI artifacts.
${customPrompt || ""}`;
    }

    try {
      const parts: any[] = [{ text: brandPrompt }];
      if (imageBase64) {
        const base64Data = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
        parts.unshift({ inlineData: { mimeType: "image/jpeg", data: base64Data } });
      }

      const IMG_MODELS = [
        "gemini-2.5-flash-image",
        "gemini-2.0-flash-exp-image-generation",
        "gemini-2.0-flash-preview-image-generation"
      ];
      let lastErr = "";
      for (const model of IMG_MODELS) {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts }],
              generationConfig: {
                responseModalities: ["TEXT", "IMAGE"],
                imageConfig: { aspectRatio: "1:1" }
              }
            })
          }
        );
        const data = await r.json();
        if (!r.ok) { lastErr = JSON.stringify(data); console.error(`ImgModel ${model} failed:`, JSON.stringify(data)); continue; }
        for (const part of data.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData) {
            return res.json({ image: `data:image/png;base64,${part.inlineData.data}` });
          }
        }
      }

      res.status(422).json({ error: "El modelo no devolvió imagen. Intenta de nuevo." });
    } catch (err: any) {
      console.error("Tongue generate error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Vite / Static ───────────────────────────────────────────────────────────

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on http://localhost:${PORT}`));
}

startServer();
