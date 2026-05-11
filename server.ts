import express, { Request, Response, NextFunction } from "express";
import axios from "axios";
import { createServer as createViteServer } from "vite";
import path from "path";
import * as cheerio from "cheerio";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
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
  app.use(express.json({ limit: "20mb" }));
  const PORT = parseInt(process.env.PORT || "3000");

  // ── Auth Routes ─────────────────────────────────────────────────────────────

  app.post("/api/auth/register", async (req, res) => {
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

  app.post("/api/auth/login", async (req, res) => {
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

  // ── Tongue / Gemini endpoints ───────────────────────────────────────────────

  app.post("/api/tongue/analyze", requireLicense as any, async (req: AuthRequest, res) => {
    const { imageBase64, brand } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "Se requiere imagen" });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY no configurada en el servidor" });

    try {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey });

      const prompt = `Analiza esta imagen de una lengüeta de zapatilla ${brand}.

      1. Extrae los datos técnicos:
      - model (ID de modelo, ej: JQ5874 o MR530SG)
      - sku (lo mismo que model)
      - reference (referencia de 12 dígitos en NB, o serie en Adidas ej: #123456789)
      - reference2 (7 dígitos en NB)
      - brandSerial (ej: LXCK1298 CLX o FGwKZ39<82143)
      - date (ej: 05/22)
      - lvl (ej: EVN 791001)
      - sizes (un objeto con us, uk, fr, jp)

      2. Genera el JSON con estos campos adicionales:
      - modelName: Nombre comercial real (ej: Adidas Samba Leopard)
      - color: Color dominante en francés (ej: blanc et vert)
      - listingTitle: Título para Vinted EXACTAMENTE así: "[modelName] - Pointure [FR] [color] / [model]"
      - listingDescription: Descripción en francés con formato: "[Frase natural]\n\nCouleur : [color]\nModèle : [model]\nTaille : [fr]"

      Si no encuentras algún dato, pon "Desconocido". Solo devuelve el JSON puro sin markdown.`;

      const result = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: {
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: imageBase64.split(",")[1] || imageBase64 } },
            { text: prompt }
          ]
        }
      });

      const text = result.text || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.status(422).json({ error: "No se pudo extraer JSON de la respuesta", raw: text });

      res.json(JSON.parse(jsonMatch[0]));
    } catch (err: any) {
      console.error("Tongue analyze error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/tongue/generate", requireLicense as any, async (req: AuthRequest, res) => {
    const { imageBase64, brand, detections, customPrompt } = req.body;
    if (!detections) return res.status(400).json({ error: "Se requieren los datos detectados" });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY no configurada en el servidor" });

    try {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey });

      let brandPrompt = "";
      if (brand === "ADIDAS") {
        brandPrompt = `CRITICAL IDENTITY RECONSTRUCTION - ADIDAS tongue label.
STRICTLY DO NOT CHANGE: ART NO/SKU "${detections.sku}", DATE "${detections.date}", FACTORY/LVL "${detections.lvl}", ALL SIZES (US ${detections.sizes?.us}, UK ${detections.sizes?.uk}, FR ${detections.sizes?.fr}, JP ${detections.sizes?.jp}).
ONLY UPDATE: Brand Serial (bottom-left): "${detections.brandSerial}", Reference (#): "${detections.reference}".
RAW LOOK: 12MP smartphone photo, natural grain. NO AI watermarks. Bold Adidas sans-serif font.
${customPrompt || ""}`;
      } else {
        brandPrompt = `NEW BALANCE internal tongue label reconstruction.
STYLE/MODEL: "${detections.sku}". DATE: "${detections.date}". FACTORY: "${detections.lvl}".
SIZES: US ${detections.sizes?.us} | UK ${detections.sizes?.uk} | EU ${detections.sizes?.fr} | CM ${detections.sizes?.jp}.
CHANGE ONLY THESE 3 CODES: SERIAL1 (12 digits): "${detections.reference}", SERIAL2 (7 digits): "${detections.reference2}", BRAND CODE: "${detections.brandSerial}".
LOOK: macro phone photo, white satin material, heavy industrial font. No AI artifacts.
${customPrompt || ""}`;
      }

      const parts: any[] = [{ text: brandPrompt }];
      if (imageBase64) {
        parts.unshift({ inlineData: { mimeType: "image/jpeg", data: imageBase64.split(",")[1] || imageBase64 } });
      }

      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash-exp-image-generation",
        contents: { parts },
        config: { responseModalities: ["TEXT", "IMAGE"] }
      });

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          return res.json({ image: `data:image/png;base64,${part.inlineData.data}` });
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
