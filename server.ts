import express, { Request, Response, NextFunction } from "express";
import axios from "axios";
import { createServer as createViteServer } from "vite";
import path from "path";
import * as cheerio from "cheerio";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pool, initDB } from "./db.js";

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

// ─── Main Server ──────────────────────────────────────────────────────────────

async function startServer() {
  await initDB();

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

  // ── Vinted Helper ───────────────────────────────────────────────────────────

  const getVintedHeaders = (cookie: string, domain: string = "es") => {
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
  };

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
    try {
      const { headers, domain: activeDomain } = getVintedHeaders(cookie, domain);
      const response = await axios.post(`https://www.vinted.${activeDomain}/api/v2/items/${itemId}/hide`, {}, { headers });
      res.json({ success: true, data: response.data });
    } catch (error: any) {
      res.status(error.response?.status || 500).json({ error: "Failed to hide item", details: error.response?.data || error.message });
    }
  });

  app.post("/api/vinted/reveal", requireLicense as any, async (req: AuthRequest, res) => {
    const { cookie, itemId, domain = "es" } = req.body;
    if (!cookie || !itemId) return res.status(400).json({ error: "Cookie and Item ID are required" });
    try {
      const { headers, domain: activeDomain } = getVintedHeaders(cookie, domain);
      const response = await axios.post(`https://www.vinted.${activeDomain}/api/v2/items/${itemId}/reveal`, {}, { headers });
      res.json({ success: true, data: response.data });
    } catch (error: any) {
      res.status(error.response?.status || 500).json({ error: "Failed to reveal item", details: error.response?.data || error.message });
    }
  });

  // ── Vinted Report v2 — multi-reason · multi-account · parallel ─────────────
  app.post("/api/vinted/report", requireLicense as any, async (req: AuthRequest, res) => {
    const { cookie, itemId, reasonId, description, domain = "es" } = req.body;
    if (!cookie || !itemId) return res.status(400).json({ error: "Cookie and Item ID are required" });

    const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8); return v.toString(16);
    });

    // ── Parse multi-account cookies (one per line or comma-separated) ────────
    const rawCookie = cookie as string;
    const allCookies: string[] = rawCookie.includes("\n")
      ? rawCookie.split("\n").map(c => c.trim()).filter(c => c.length > 10)
      : [rawCookie.trim()];

    // ── Determine domains to target for each cookie ──────────────────────────
    const getDomainsForCookie = (ck: string): string[] => {
      const d: string[] = [];
      if (ck.includes("_vinted_fr_session")) d.push("fr");
      if (ck.includes("_vinted_es_session")) d.push("es");
      if (ck.includes("_vinted_it_session")) d.push("it");
      if (ck.includes("_vinted_de_session")) d.push("de");
      if (ck.includes("_vinted_pl_session")) d.push("pl");
      if (!d.includes(domain)) d.push(domain);
      // Spread to all domains — cross-domain reports go to global moderation queue
      ["fr", "es", "it", "de", "pl", "be", "nl"].forEach(x => { if (!d.includes(x)) d.push(x); });
      return d;
    };

    // ── Reason configs — hit MULTIPLE moderation queues simultaneously ───────
    // Each reason_id routes to a different internal team at Vinted:
    //   1 = Counterfeit/IP (legal team, fastest automated action)
    //   2 = Item not as described (quality team)
    //   4 = Prohibited/illegal item (safety team, automated removal)
    //  11 = Spam/duplicate listing (anti-spam bot, instant flag)
    const primaryReason = parseInt(reasonId || "1");

    const REASON_PAYLOADS = [
      // Primary reason (user-selected or default counterfeit)
      {
        reason_id: primaryReason,
        description: description || "This item is a non-authentic replica. It uses copyrighted brand imagery and serial numbers known to be associated with counterfeit batches. This violates Vinted Integrity Policy and applicable IP law.",
        suspected_counterfeit: primaryReason === 1,
        ...(primaryReason === 1 ? { brand_name: "unknown" } : {}),
      },
      // Prohibited item — parallel queue
      {
        reason_id: 4,
        description: "Article belongs to prohibited items list. Poses transaction risk. Requires immediate automated quarantine per platform safety policy.",
      },
      // Spam/duplicate — anti-spam bot queue (near-instant processing)
      {
        reason_id: 11,
        description: "Duplicate listing. Same item posted multiple times across different accounts to manipulate search visibility.",
      },
    ].filter((p, i) => i === 0 || p.reason_id !== primaryReason); // skip dupes

    // ── Fire a single complaint (one cookie, one domain, one reason) ─────────
    const fireOne = async (ck: string, dom: string, reasonPayload: any): Promise<{ ok: boolean; status: number; dom: string; reason: number }> => {
      const { headers } = getVintedHeaders(ck, dom);
      headers["Referer"] = `https://www.vinted.${dom}/items/${itemId}`;
      headers["Origin"] = `https://www.vinted.${dom}`;
      headers["X-Vinted-Idempotency-Key"] = uuid();

      const id = parseInt(itemId);
      const payload = { complaint: { item_id: id, ...reasonPayload } };
      const payload2 = { complaint: { entity_id: id, entity_type: "Item", ...reasonPayload } };

      for (const body of [payload, payload2]) {
        try {
          const r = await axios.post(
            `https://www.vinted.${dom}/api/v2/complaints`,
            body,
            { headers, timeout: 8000, maxRedirects: 0, validateStatus: s => s < 500 }
          );
          if (r.status === 401) return { ok: false, status: 401, dom, reason: reasonPayload.reason_id };
          if (r.status < 300) return { ok: true, status: r.status, dom, reason: reasonPayload.reason_id };
        } catch {}
      }
      return { ok: false, status: 0, dom, reason: reasonPayload.reason_id };
    };

    try {
      // ── Build all tasks: every cookie × primary domain × every reason ──────
      const tasks: Promise<{ ok: boolean; status: number; dom: string; reason: number }>[] = [];

      for (const ck of allCookies) {
        const domains = getDomainsForCookie(ck);
        const primaryDom = domains[0]; // best domain for this cookie

        // Fire all reasons on the primary domain (parallel)
        for (const rp of REASON_PAYLOADS) {
          tasks.push(fireOne(ck, primaryDom, rp));
        }

        // Also fire primary reason on all other domains (parallel, for cross-domain pressure)
        for (const dom of domains.slice(1, 5)) {
          tasks.push(fireOne(ck, dom, REASON_PAYLOADS[0]));
        }
      }

      console.log(`[report] Firing ${tasks.length} parallel complaint requests for item ${itemId}`);
      const results = await Promise.all(tasks);

      // 401 on primary = bad session
      if (results[0]?.status === 401) return res.status(401).json({ error: "Sesión inválida o expirada." });

      const hits = results.filter(r => r.ok);
      const byReason: Record<number, number> = {};
      hits.forEach(r => { byReason[r.reason] = (byReason[r.reason] || 0) + 1; });

      if (hits.length > 0) {
        return res.json({
          success: true,
          total: results.length,
          hits: hits.length,
          byReason,
          accounts: allCookies.length,
          message: `${hits.length}/${results.length} reportes enviados desde ${allCookies.length} cuenta(s).`,
        });
      }

      const lastStatus = results.find(r => r.status > 0)?.status || 500;
      res.status(lastStatus).json({ error: "Todos los reportes fallaron.", total: results.length, hits: 0 });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Vinted Nuke — sustained multi-reason pressure over N seconds ───────────
  app.post("/api/vinted/spam-checkout", requireLicense as any, async (req: AuthRequest, res) => {
    const { cookie, itemId, domain = "es" } = req.body;
    if (!cookie || !itemId) return res.status(400).json({ error: "Cookie and Item ID are required" });

    const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8); return v.toString(16);
    });

    const rawCookie = cookie as string;
    const cookies = rawCookie.includes("\n")
      ? rawCookie.split("\n").map(c => c.trim()).filter(c => c.length > 10)
      : [rawCookie.trim()];

    const id = parseInt(itemId.toString());
    const activeDomains = [...new Set([domain, "fr", "es", "it", "pl", "be", "de", "nl"])];

    // Reason rotation: counterfeit → prohibited → spam → repeat
    // Each wave hits a different internal queue
    const reasons = [
      { reason_id: 1, suspected_counterfeit: true, description: "Non-authentic item. Counterfeit batch serial. IP violation." },
      { reason_id: 4, description: "Prohibited item. Safety risk. Requires automated quarantine." },
      { reason_id: 11, description: "Spam listing. Duplicate across multiple seller accounts." },
      { reason_id: 2, description: "Item not as described. Misleading photos and description." },
    ];

    let totalSuccess = 0;
    let wave = 0;
    const endTime = Date.now() + 90_000; // 90 seconds

    while (Date.now() < endTime) {
      const reason = reasons[wave % reasons.length];
      wave++;

      await Promise.all(cookies.flatMap(ck =>
        activeDomains.map(async dom => {
          try {
            const { headers } = getVintedHeaders(ck, dom);
            headers["Referer"] = `https://www.vinted.${dom}/items/${id}`;
            headers["Origin"] = `https://www.vinted.${dom}`;
            headers["X-Vinted-Idempotency-Key"] = uuid();

            const body = { complaint: { item_id: id, ...reason } };
            const r = await axios.post(
              `https://www.vinted.${dom}/api/v2/complaints`,
              body,
              { headers, timeout: 5000, validateStatus: () => true }
            );
            if (r.status < 300) totalSuccess++;
          } catch {}
        })
      ));

      await new Promise(r => setTimeout(r, 800));
    }

    res.json({
      success: totalSuccess > 0,
      count: totalSuccess,
      waves: wave,
      accounts: cookies.length,
      message: `NUKE COMPLETADO. ${totalSuccess} impactos en ${wave} oleadas desde ${cookies.length} cuenta(s).`,
    });
  });

  // ── Vinted Like+Offer — replicates Blackstock's worker action ──────────────
  // Blackstock workers: open tab → click heart → open offer dialog → submit offer
  // We replicate the underlying API calls: favourite + offer at minimum price
  app.post("/api/vinted/like-offer", requireLicense as any, async (req: AuthRequest, res) => {
    const { cookie, itemId, domain = "es" } = req.body;
    if (!cookie || !itemId) return res.status(400).json({ error: "Cookie and itemId required" });

    const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8); return v.toString(16);
    });

    const rawCookie = cookie as string;
    const allCookies: string[] = rawCookie.includes("\n")
      ? rawCookie.split("\n").map(c => c.trim()).filter(c => c.length > 10)
      : [rawCookie.trim()];

    const id = parseInt(itemId.toString());

    // Step 1: fetch item details to get price
    let itemPrice: number | null = null;
    let currency = "EUR";
    let sellerId: number | null = null;
    try {
      const { headers } = getVintedHeaders(allCookies[0], domain);
      const itemRes = await axios.get(
        `https://www.vinted.${domain}/api/v2/items/${id}`,
        { headers, timeout: 8000, validateStatus: () => true }
      );
      if (itemRes.status === 200 && itemRes.data?.item) {
        const item = itemRes.data.item;
        itemPrice = parseFloat(item.price_numeric || item.price || "0");
        currency = item.currency || "EUR";
        sellerId = item.user?.id || null;
      }
    } catch {}

    // Minimum offer = 70% of price (Vinted minimum), rounded down to .00
    const offerPrice = itemPrice ? Math.max(1, Math.floor(itemPrice * 0.70 * 100) / 100).toFixed(2) : null;

    const results: { cookie_idx: number; favourite: boolean; offer: boolean; error?: string }[] = [];

    await Promise.all(allCookies.map(async (ck, idx) => {
      const result = { cookie_idx: idx, favourite: false, offer: false };
      try {
        const { headers } = getVintedHeaders(ck, domain);
        headers["Referer"] = `https://www.vinted.${domain}/items/${id}`;
        headers["Origin"] = `https://www.vinted.${domain}`;
        headers["X-Vinted-Idempotency-Key"] = uuid();

        // 1. Add to favourites — exact same call as clicking ❤️ button
        const favRes = await axios.post(
          `https://www.vinted.${domain}/api/v2/items/${id}/favourite`,
          {},
          { headers, timeout: 8000, validateStatus: () => true }
        );
        result.favourite = favRes.status < 300;

        // 2. Send offer at minimum price (buyer must differ from seller)
        if (offerPrice && sellerId) {
          await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
          headers["X-Vinted-Idempotency-Key"] = uuid();
          const offerRes = await axios.post(
            `https://www.vinted.${domain}/api/v2/offers`,
            { offer: { item_id: id, price: offerPrice, currency_code: currency } },
            { headers, timeout: 8000, validateStatus: () => true }
          );
          result.offer = offerRes.status < 300;
        }
      } catch (e: any) {
        (result as any).error = e.message;
      }
      results.push(result);
    }));

    const favHits = results.filter(r => r.favourite).length;
    const offerHits = results.filter(r => r.offer).length;

    res.json({
      success: favHits > 0,
      favourites: favHits,
      offers: offerHits,
      accounts: allCookies.length,
      itemPrice,
      offerPrice,
      message: `❤️ ${favHits} favoritos + 💬 ${offerHits} ofertas enviadas desde ${allCookies.length} cuenta(s).`,
    });
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
        return res.json(JSON.parse(jsonMatch[0]));
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

    // ── Prompts ultra-específicos por marca ─────────────────────────────────
    // Framing: "photo editor" task, not "reconstruction". Much clearer instructions.
    let brandPrompt = "";

    if (brand === "ADIDAS") {
      brandPrompt = `You are a precise photo editor. I am giving you a photo of an Adidas shoe tongue label.

YOUR TASK: Edit ONLY these two text values in the image. Change nothing else.

VALUES TO UPDATE:
- The barcode/serial number that starts with "#" → replace with: ${detections.reference}
- The 13-character alphanumeric code at the very bottom (after the word "adidas") → replace with: ${detections.brandSerial}

DO NOT TOUCH (keep pixel-perfect identical):
- ART NO / article number: ${detections.sku}
- Date code: ${detections.date}
- Factory / LVL code: ${detections.lvl}
- All size info: US ${detections.sizes?.us} / UK ${detections.sizes?.uk} / FR ${detections.sizes?.fr} / JP ${detections.sizes?.jp}
- All graphics, logos, fonts, colors, background texture, stitching, lighting

OUTPUT: A photorealistic image of a real Adidas tongue label, taken with a smartphone camera. Same angle, same lighting, same fabric texture as the input. No watermarks. No AI artifacts.
${customPrompt ? `\nADDITIONAL RULES:\n${customPrompt}` : ""}`;

    } else if (brand === "ASICS") {
      brandPrompt = `You are a precise photo editor. I am giving you a photo of an ASICS shoe tongue label.

YOUR TASK: Edit ONLY these two text values in the image. Change nothing else.

VALUES TO UPDATE:
- Tracking/batch code (format: letter + 6 digits, e.g. F960925) → replace with: ${detections.reference}
- Unit serial number (15 uppercase alphanumeric chars) → replace with: ${detections.brandSerial}

DO NOT TOUCH (keep pixel-perfect identical):
- SKU / model code: ${detections.sku}
- Date: ${detections.date}
- All size info: US ${detections.sizes?.us} / UK ${detections.sizes?.uk} / FR ${detections.sizes?.fr} / JP ${detections.sizes?.jp}
- Size table vertical dividers (|), compressed ASICS typography, all other text

OUTPUT: A photorealistic macro photo of a real ASICS tongue label. Same lighting, angle, fabric texture as the input. No AI artifacts.
${customPrompt ? `\nADDITIONAL RULES:\n${customPrompt}` : ""}`;

    } else if (brand === "ONITSUKA") {
      brandPrompt = `You are a precise photo editor. I am giving you a photo of an Onitsuka Tiger shoe tongue label.

YOUR TASK: Edit ONLY these two text values in the image. Change nothing else.

VALUES TO UPDATE:
- Batch code (format: F + 6 digits) → replace with: ${detections.reference}
- Unit serial (15 uppercase alphanumeric chars) → replace with: ${detections.brandSerial}

DO NOT TOUCH (keep pixel-perfect identical):
- Top SKU code: ${detections.sku}
- Date: ${detections.date}
- Size grid: CM ${detections.sizes?.jp} / EURO ${detections.sizes?.fr} / US ${detections.sizes?.us} / UK ${detections.sizes?.uk}
- "MADE IN INDONESIA" and "FABRIQUE EN INDONESIE" text
- All fonts, borders, background, stitching, thermal-print look

OUTPUT: A photorealistic photo of a real Onitsuka Tiger tongue label. Same angle, lighting and white matte fabric texture as input. No AI artifacts.
${customPrompt ? `\nADDITIONAL RULES:\n${customPrompt}` : ""}`;

    } else {
      // NEW BALANCE
      brandPrompt = `You are a precise photo editor. I am giving you a photo of a New Balance shoe tongue label.

YOUR TASK: Edit ONLY these three serial codes in the image. Change nothing else.

VALUES TO UPDATE:
- 12-digit barcode number → replace with: ${detections.reference}
- 7-digit number → replace with: ${detections.reference2}
- Brand serial code (format: 4 letters + 4 digits + space + 3 letters) → replace with: ${detections.brandSerial}

DO NOT TOUCH (keep pixel-perfect identical):
- Model / style code: ${detections.sku}
- Date: ${detections.date}
- Factory code: ${detections.lvl}
- All size info: US ${detections.sizes?.us} / UK ${detections.sizes?.uk} / EU ${detections.sizes?.fr} / CM ${detections.sizes?.jp}
- White satin fabric texture, all fonts, stitching, logo, lighting, angle

OUTPUT: A photorealistic macro photo of a real New Balance tongue label taken with a smartphone. Same lighting and fabric texture as input. No watermarks, no AI artifacts.
${customPrompt ? `\nADDITIONAL RULES:\n${customPrompt}` : ""}`;
    }

    // ── Helper: one attempt at one model ────────────────────────────────────
    const tryGenerate = async (model: string, parts: any[]): Promise<string | null> => {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts }],
              generationConfig: {
                responseModalities: ["TEXT", "IMAGE"],
                // Portrait ratio — tongue labels are taller than wide
                imageConfig: { aspectRatio: "3:4" }
              }
            })
          }
        );
        const data = await r.json();
        if (!r.ok) { console.error(`[tongue] ${model} HTTP error:`, JSON.stringify(data).slice(0, 200)); return null; }
        for (const part of data.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData?.data) return `data:image/png;base64,${part.inlineData.data}`;
        }
        return null;
      } catch (e: any) {
        console.error(`[tongue] ${model} exception:`, e.message);
        return null;
      }
    };

    try {
      const base64Data = imageBase64?.includes(",") ? imageBase64.split(",")[1] : (imageBase64 || "");
      const parts: any[] = [];
      if (base64Data) parts.push({ inlineData: { mimeType: "image/jpeg", data: base64Data } });
      parts.push({ text: brandPrompt });

      // ── Strategy: fire 2 parallel attempts per model, use first success ──
      const IMG_MODELS = [
        "gemini-2.0-flash-exp-image-generation",
        "gemini-2.0-flash-preview-image-generation",
        "gemini-2.5-flash-image",
      ];

      // Round 1: fire first two models in parallel
      console.log(`[tongue] Starting parallel generation for ${brand}`);
      const round1 = await Promise.allSettled([
        tryGenerate(IMG_MODELS[0], parts),
        tryGenerate(IMG_MODELS[1], parts),
      ]);
      for (const r of round1) {
        if (r.status === "fulfilled" && r.value) {
          console.log(`[tongue] Round 1 success`);
          return res.json({ image: r.value });
        }
      }

      // Round 2: retry with the two best models simultaneously
      console.log(`[tongue] Round 1 failed, starting round 2`);
      const round2 = await Promise.allSettled([
        tryGenerate(IMG_MODELS[0], parts),
        tryGenerate(IMG_MODELS[2], parts),
      ]);
      for (const r of round2) {
        if (r.status === "fulfilled" && r.value) {
          console.log(`[tongue] Round 2 success`);
          return res.json({ image: r.value });
        }
      }

      // Round 3: last resort — single attempt on most reliable model
      console.log(`[tongue] Round 2 failed, starting round 3`);
      const final = await tryGenerate(IMG_MODELS[0], parts);
      if (final) return res.json({ image: final });

      res.status(422).json({ error: "El modelo no devolvió imagen tras 5 intentos. Espera 30 segundos e inténtalo de nuevo." });
    } catch (err: any) {
      console.error("Tongue generate error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Tongue Prompts (admin manage / public read) ────────────────────────────

  app.get("/api/tongue/prompts", async (_req, res) => {
    try {
      const result = await pool.query("SELECT brand, prompt, updated_at FROM tongue_prompts ORDER BY brand");
      res.json(result.rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/tongue/prompts", requireAdmin as any, async (req, res) => {
    const { brand, prompt } = req.body;
    const validBrands = ["ADIDAS", "NEW BALANCE", "ASICS", "ONITSUKA"];
    if (!brand || !validBrands.includes(brand))
      return res.status(400).json({ error: "Marca inválida. Usa: ADIDAS, NEW BALANCE, ASICS u ONITSUKA" });
    try {
      const result = await pool.query(
        `INSERT INTO tongue_prompts (brand, prompt, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (brand) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = NOW()
         RETURNING *`,
        [brand, prompt ?? ""]
      );
      res.json(result.rows[0]);
    } catch (err: any) {
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
