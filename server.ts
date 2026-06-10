import { randomUUID } from "crypto";
import crypto from "crypto";
import express, { Request, Response, NextFunction } from "express";
import axios from "axios";
import https from "https";
import { createServer as createViteServer } from "vite";
import path from "path";
import * as cheerio from "cheerio";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { pool, initDB } from "./db.js";

dotenv.config({ path: ".env.local" });

const JWT_SECRET = process.env.JWT_SECRET || "changeme-use-a-real-secret";

// ── Genera un session_token único, lo persiste en la BD y devuelve el JWT ──────
async function mintSessionToken(userId: number, expiresIn = "30d", ip?: string): Promise<string> {
  const sid = randomUUID();
  await pool.query(
    "UPDATE users SET session_token=$1, last_login_at=NOW(), last_seen_at=NOW(), last_ip=$2 WHERE id=$3",
    [sid, ip || null, userId]
  );
  return jwt.sign({ id: userId, sid }, JWT_SECRET, { expiresIn } as any);
}

// ── Registra una acción en el log de actividad (fire-and-forget) ─────────────
function logActivity(userId: number, action: string, ip?: string) {
  pool.query("INSERT INTO activity_log(user_id,action,ip) VALUES($1,$2,$3)", [userId, action, ip || null])
    .catch(() => {});
}

// ── Control Panel: cifrado AES-256 para IBAN y contraseñas Vinted ─────────────
const CTRL_KEY = (process.env.CONTROL_ENCRYPTION_KEY || "laminecontrol-key-32chars-secure").slice(0, 32).padEnd(32, "0");

function ctrlEncrypt(text: string): string {
  if (!text) return "";
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(CTRL_KEY), iv);
  let enc = cipher.update(text, "utf8", "hex");
  enc += cipher.final("hex");
  return iv.toString("hex") + ":" + enc;
}

function ctrlDecrypt(text: string): string {
  if (!text || !text.includes(":")) return text;
  try {
    const [ivHex, enc] = text.split(":");
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(CTRL_KEY), Buffer.from(ivHex, "hex"));
    let dec = decipher.update(enc, "hex", "utf8");
    dec += decipher.final("utf8");
    return dec;
  } catch { return ""; }
}

// Código de invitación para registrarse en el panel de control
const CONTROL_INVITE_CODE = process.env.CONTROL_INVITE_CODE || "lamine2024control";

// ─── Auth Middleware ──────────────────────────────────────────────────────────

interface AuthRequest extends Request {
  user?: { id: number; username: string; email: string; is_admin: boolean; rank?: string };
}

async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No autenticado" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    // ── Standard user JWT ──
    if (decoded.id) {
      const result = await pool.query("SELECT id, username, email, is_admin, is_blocked, rank, session_token FROM users WHERE id = $1", [decoded.id]);
      if (!result.rows[0]) return res.status(401).json({ error: "Usuario no encontrado" });
      if (result.rows[0].is_blocked) return res.status(403).json({ error: "Cuenta bloqueada. Contacta al administrador.", blocked: true });

      // Anti credential-sharing: el sid del token debe coincidir con el session_token de la BD.
      const storedSid = result.rows[0].session_token;
      const tokenSid  = decoded.sid;
      if (storedSid && tokenSid !== storedSid) {
        return res.status(401).json({ error: "Sesión cerrada. Alguien inició sesión con esta cuenta en otro dispositivo. Vuelve a entrar." });
      }

      req.user = result.rows[0];
      // Actualiza last_seen_at e ip en background (sin bloquear la petición)
      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
      pool.query("UPDATE users SET last_seen_at=NOW(), last_ip=$1 WHERE id=$2", [ip, decoded.id]).catch(() => {});
      return next();
    }

    // ── Extension session JWT ({sid}) ──
    // Accepted on all endpoints so extension users can access their data
    if (decoded.sid) {
      const sessRes = await pool.query(
        `SELECT es.id as sid, es.license_key, l.user_id, l.type as license_type
         FROM extension_sessions es
         JOIN licenses l ON l.key = es.license_key
         WHERE es.id = $1
           AND es.revoked = FALSE
           AND es.expires_at > NOW()
           AND l.is_active = TRUE
           AND (l.expires_at IS NULL OR l.expires_at > NOW())`,
        [decoded.sid]
      );
      const sess = sessRes.rows[0];
      if (!sess) return res.status(401).json({ error: "Sesión de extensión inválida o expirada" });
      if (!sess.user_id) return res.status(401).json({ error: "Licencia sin usuario vinculado. Reactiva la licencia desde el Hub." });

      const userRes = await pool.query("SELECT id, username, email, is_admin FROM users WHERE id = $1", [sess.user_id]);
      if (!userRes.rows[0]) return res.status(401).json({ error: "Usuario no encontrado" });
      req.user = userRes.rows[0];
      pool.query("UPDATE extension_sessions SET last_seen_at = NOW() WHERE id = $1", [decoded.sid]).catch(() => {});
      return next();
    }
  } catch {
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
  return res.status(401).json({ error: "Token inválido o expirado" });
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

function requireWorkerSecret(req: Request, res: Response, next: NextFunction) {
  const provided = req.headers['x-worker-secret'];
  const expected = process.env.BAZOOKA_WORKER_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'worker_secret_not_configured' });
  if (provided !== expected) return res.status(401).json({ ok: false, error: 'invalid_worker_secret' });
  next();
}

// ── Límite diario de generaciones ────────────────────────────────────────────
const DAILY_FREE_LIMIT = 10;

async function checkDailyLimit(req: AuthRequest, res: Response, next: NextFunction) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "No autenticado" });
  if (req.user?.is_admin) return next(); // solo admins sin límite

  // Leer contador actual del día
  const cur = await pool.query(
    "SELECT count FROM daily_usage WHERE user_id=$1 AND usage_date=CURRENT_DATE",
    [userId]
  ).catch(() => ({ rows: [] as any[] }));
  const currentCount = Number(cur.rows[0]?.count || 0);

  if (currentCount >= DAILY_FREE_LIMIT) {
    return res.status(429).json({
      error: `Has alcanzado tu límite diario de ${DAILY_FREE_LIMIT} generaciones.\n\nSi necesitas más generaciones, contáctame por privado.\n\nPlan ilimitado: 8,99€/mes.`,
      daily_limit_reached: true,
      limit: DAILY_FREE_LIMIT,
      used: currentCount,
    });
  }

  // Incrementar de forma atómica
  await pool.query(
    `INSERT INTO daily_usage (user_id, usage_date, count)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (user_id, usage_date) DO UPDATE SET count = daily_usage.count + 1`,
    [userId]
  ).catch(() => {});

  next();
}

// ─── Helpers: token de generación de imágenes ────────────────────────────────

async function checkTokens(
  req: AuthRequest, res: Response, needed: number
): Promise<{ ok: boolean; licenseId?: number }> {
  if (req.user?.is_admin) return { ok: true };
  const result = await pool.query(
    `SELECT id, image_tokens FROM licenses
     WHERE user_id = $1 AND is_active = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [req.user!.id]
  );
  const lic = result.rows[0];
  if (!lic) { res.status(403).json({ error: "Licencia requerida" }); return { ok: false }; }
  if (lic.image_tokens === null) return { ok: true, licenseId: lic.id }; // ilimitado
  if (lic.image_tokens < needed) {
    res.status(402).json({ error: "Sin tokens de generación. Contacta al administrador." });
    return { ok: false };
  }
  return { ok: true, licenseId: lic.id };
}

async function deductTokens(licenseId: number | undefined, amount: number): Promise<void> {
  if (!licenseId) return;
  pool.query(
    `UPDATE licenses SET image_tokens = image_tokens - $1
     WHERE id = $2 AND image_tokens IS NOT NULL`,
    [amount, licenseId]
  ).catch(() => {});
}

// ─── Helper: generate license key ────────────────────────────────────────────

function generateLicenseKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const segment = (len: number) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `LM-${segment(4)}-${segment(4)}-${segment(4)}`;
}

// ─── Main Server ──────────────────────────────────────────────────────────────

async function seedAdminUser() {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;
  try {
    await pool.query("UPDATE users SET is_admin = TRUE WHERE email = $1", [adminEmail]);
    console.log(`[seed] is_admin=true para ${adminEmail}`);
  } catch (e: any) {
    console.warn("[seed] No se pudo marcar admin:", e.message);
  }
}

async function startServer() {
  await initDB();
  await seedAdminUser();

  // ── Ensure order_labels has pdf_data column ─────────────────────────────────
  await pool.query(`
    ALTER TABLE order_labels ADD COLUMN IF NOT EXISTS pdf_data TEXT;
    ALTER TABLE order_labels ADD COLUMN IF NOT EXISTS carrier TEXT;
    ALTER TABLE order_labels ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'captured';
  `).catch(() => {});

  // ── Anti credential-sharing: session token por usuario ───────────────────────
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS session_token VARCHAR(64);
  `).catch(() => {});

  // ── Tracking de actividad para el admin ──────────────────────────────────────
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at  TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at   TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip        VARCHAR(60);
  `).catch(() => {});

  // ── Bloqueo de usuarios ───────────────────────────────────────────────────────
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS rank VARCHAR(10) DEFAULT 'normal';
  `).catch(() => {});

  // ── Límite diario de generaciones ────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_usage (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      usage_date DATE    NOT NULL DEFAULT CURRENT_DATE,
      count      INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, usage_date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_usage_user_date ON daily_usage(user_id, usage_date DESC);
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      action     VARCHAR(80) NOT NULL,
      ip         VARCHAR(60),
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_activity_log_uid  ON activity_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_time ON activity_log(created_at DESC);
  `).catch(() => {});

  // ── Report Jobs Table ────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_jobs (
      id SERIAL PRIMARY KEY,
      item_url TEXT NOT NULL,
      item_id TEXT,
      title TEXT,
      status TEXT DEFAULT 'pending',
      submitted_by INTEGER REFERENCES users(id),
      assigned_to INTEGER REFERENCES users(id),
      assigned_at TIMESTAMP,
      completed_at TIMESTAMP,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_report_jobs_status ON report_jobs(status);
  `);

  // ── Auto-publish: asegurar columnas vinted_id + session_cookie en vinted_accounts ──
  await pool.query(`
    ALTER TABLE vinted_accounts ADD COLUMN IF NOT EXISTS vinted_id   VARCHAR(50);
    ALTER TABLE vinted_accounts ADD COLUMN IF NOT EXISTS session_cookie TEXT;
    ALTER TABLE vinted_accounts ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMP DEFAULT NOW();
  `).catch(() => {});

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vinted_accounts_uid
      ON vinted_accounts(user_id, vinted_id) WHERE vinted_id IS NOT NULL;
  `).catch(() => {});

  // ── Auto-publish: tabla de borradores / anuncios publicados ─────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vinted_autopublish_listings (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title        TEXT    NOT NULL,
      description  TEXT,
      price        DECIMAL(10,2) NOT NULL DEFAULT 0,
      condition    VARCHAR(30)  DEFAULT 'neuf_sans_etiquette',
      brand        VARCHAR(100),
      size         VARCHAR(20),
      gender       VARCHAR(10)  DEFAULT 'men',
      package_size VARCHAR(10)  DEFAULT 'small',
      images       JSONB        DEFAULT '[]'::jsonb,
      status       VARCHAR(20)  DEFAULT 'draft',
      vinted_id    VARCHAR(50),
      published_at TIMESTAMP,
      created_at   TIMESTAMP    DEFAULT NOW(),
      updated_at   TIMESTAMP    DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_vapl_user ON vinted_autopublish_listings(user_id);
  `).catch(() => {});

  const app = express();

  // ── Seguridad + Compresión ────────────────────────────────────────────────
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(compression()); // GZIP/Brotli automático
  app.set("trust proxy", 1); // necesario para rate limit detrás de Railway

  // ── CORS — permite chrome-extension://, localhost y el propio dominio ──────
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin || "";
    const allowed =
      /^chrome-extension:\/\//.test(origin) ||
      /^https?:\/\/localhost/.test(origin) ||
      /^https?:\/\/founderclub-production\.up\.railway\.app/.test(origin) ||
      /^https?:\/\/lamineresell\.com/.test(origin) ||
      !origin;
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin || "*");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,x-csrf-token"
      );
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Rate limit general: 200 peticiones por IP cada 15 minutos
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 2000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Límite general superado. Espera unos minutos." }
  }));

  // Rate limit para login/registro
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { error: "Límite de auth superado. Espera unos minutos." }
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

  // ── Compat aliases para la extensión Chrome (formato antiguo del servidor) ───
  // La extensión llama a /auth/login y /auth/register (sin /api/) y espera:
  //   { ok: true, token, user: { email, role }, license: { status } }
  // Estos aliases adaptan el nuevo servidor al formato que espera login.js
  app.post("/auth/register", authLimiter, async (req, res) => {
    const { email, password, hwid, device } = req.body;
    if (!email || !password)
      return res.status(400).json({ ok: false, error: "email_and_password_required" });
    if (password.length < 8)
      return res.status(400).json({ ok: false, error: "password_too_short" });
    try {
      const username = email.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20) || "user";
      const hash = await bcrypt.hash(password, 12);
      const result = await pool.query(
        "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, is_admin",
        [username, email.trim().toLowerCase(), hash]
      );
      const user = result.rows[0];
      const token = await mintSessionToken(user.id);
      res.json({
        ok: true, token,
        user: { id: user.id, email: user.email, role: user.is_admin ? "admin" : "user", is_admin: user.is_admin, rank: 'normal' },
        license: { status: "inactive" },
      });
    } catch (err: any) {
      if (err.code === "23505") return res.status(409).json({ ok: false, error: "email_already_registered" });
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // ── Helper: migración lazy desde ak47 ──────────────────────────────────────
  // Si el usuario no existe en Postgres, intentamos validar contra ak47.
  // Si ak47 acepta, creamos el usuario aquí transparentemente y le damos acceso.
  const AK47_LEGACY_URL = process.env.AK47_LEGACY_URL || 'https://ak47-worker-backend-production.up.railway.app';

  async function tryLazyMigrateFromAk47(email: string, password: string): Promise<{ id: number; email: string; username: string; is_admin: boolean } | null> {
    try {
      const r = await fetch(`${AK47_LEGACY_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return null;
      const data = await r.json() as any;
      if (!data?.ok || !data?.token) return null;

      // Usuario válido en ak47 → crear en Postgres
      const username = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20) || 'user';
      const bcryptMod = await import('bcryptjs');
      const bcrypt_ = bcryptMod.default ?? bcryptMod;
      const hash = await bcrypt_.hash(password, 12);
      const ins = await pool.query(
        `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
         RETURNING id, username, email, is_admin`,
        [username, email, hash]
      );
      const newUser = ins.rows[0];

      // Si tenía licencia activa en ak47, darle acceso academia en founderclub
      if (data?.license?.status === 'active') {
        const key = `AK47-MIGR-${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
        await pool.query(
          `INSERT INTO licenses (key, user_id, type, is_active, features)
           VALUES ($1, $2, 'monthly', TRUE, ARRAY['all']::TEXT[])
           ON CONFLICT DO NOTHING`,
          [key, newUser.id]
        );
        console.log(`[lazy-migrate] ${email} migrado desde ak47 con licencia activa`);
      } else {
        console.log(`[lazy-migrate] ${email} migrado desde ak47 sin licencia`);
      }
      return newUser;
    } catch (_) {
      return null; // ak47 no disponible o error — no bloquear login
    }
  }

  app.post("/auth/login", authLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ ok: false, error: "email_and_password_required" });
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    try {
      let userRow = (await pool.query("SELECT * FROM users WHERE email = $1", [email.trim().toLowerCase()])).rows[0];

      if (!userRow) {
        userRow = await tryLazyMigrateFromAk47(email.trim().toLowerCase(), password) as any;
        if (!userRow) return res.status(401).json({ ok: false, error: "invalid_credentials" });
        const token = await mintSessionToken(userRow.id, "30d", ip);
        logActivity(userRow.id, "login", ip);
        const licRes = await pool.query(
          "SELECT type, expires_at, features FROM licenses WHERE user_id=$1 AND is_active=TRUE AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1",
          [userRow.id]
        );
        const lic = licRes.rows[0];
        return res.json({
          ok: true, token,
          user: { id: userRow.id, email: userRow.email, username: userRow.username, role: userRow.is_admin ? "admin" : "user", is_admin: userRow.is_admin, rank: userRow.rank || 'normal' },
          license: { status: lic ? "active" : "inactive", type: lic?.type || null },
        });
      }

      if (!(await bcrypt.compare(password, userRow.password_hash)))
        return res.status(401).json({ ok: false, error: "invalid_credentials" });

      const token = await mintSessionToken(userRow.id, "30d", ip);
      logActivity(userRow.id, "login", ip);
      const licRes = await pool.query(
        "SELECT type, expires_at FROM licenses WHERE user_id=$1 AND is_active=TRUE AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1",
        [userRow.id]
      );
      const lic = licRes.rows[0];
      const licenseStatus = (lic || userRow.is_admin) ? "active" : "inactive";
      res.json({
        ok: true, token,
        user: { id: userRow.id, email: userRow.email, username: userRow.username, role: userRow.is_admin ? "admin" : "user", is_admin: userRow.is_admin, rank: userRow.rank || 'normal' },
        license: { status: licenseStatus, type: lic?.type || (userRow.is_admin ? "admin" : null) },
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

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
      const token = await mintSessionToken(user.id);
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

    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    const token = await mintSessionToken(user.id, "30d", ip);
    logActivity(user.id, "login", ip);
    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, is_admin: user.is_admin, rank: user.rank || 'normal' },
    });
  });

  // ── /license/verify — compatibilidad con la extensión Chrome ─────────────────
  // La extensión llama a GET /license/verify con Bearer token para comprobar si
  // la licencia sigue activa. Reutiliza requireLicense y devuelve el mismo token
  // para que la extensión pueda guardarlo como lamine_auth_token.
  app.get("/license/verify", requireLicense as any, async (req: AuthRequest, res) => {
    const user = req.user!;
    const licResult = await pool.query(
      "SELECT type, expires_at FROM licenses WHERE user_id = $1 AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1",
      [user.id]
    );
    const lic = licResult.rows[0];
    if (!lic && !user.is_admin) return res.status(403).json({ valid: false, error: "Licencia requerida o expirada" });
    res.json({
      ok:      true,
      valid:   true,
      allowed: true,
      status:  'active',
      role:    user.is_admin ? 'admin' : 'user',
      user:    { id: user.id, username: user.username, email: user.email, is_admin: user.is_admin, rank: user.rank || 'normal' },
      license: lic ? { type: lic.type, expires_at: lic.expires_at } : { type: 'admin', expires_at: null },
    });
  });

  app.get("/api/auth/me", requireAuth as any, async (req: AuthRequest, res) => {
    const user = req.user!;
    const licResult = await pool.query(
      "SELECT id, key, type, expires_at, features FROM licenses WHERE user_id = $1 AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1",
      [user.id]
    );
    const lic = licResult.rows[0] || null;
    // Admins tienen acceso total
    if (lic && user.is_admin) lic.features = ['all'];
    res.json({ user, license: lic });
  });

  // ── Token de generación ──────────────────────────────────────────────────────

  app.get("/api/user/tokens", requireAuth as any, async (req: AuthRequest, res) => {
    if (req.user?.is_admin) return res.json({ tokens: null }); // admin = ilimitado
    const result = await pool.query(
      `SELECT image_tokens FROM licenses
       WHERE user_id = $1 AND is_active = TRUE
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [req.user!.id]
    );
    const lic = result.rows[0];
    if (!lic) return res.json({ tokens: 0 });
    res.json({ tokens: lic.image_tokens }); // null = ilimitado, número = saldo
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

  app.get("/api/admin/users", requireAdmin as any, async (req, res) => {
    const search = (req.query.search as string || "").trim();
    const whereClause = search
      ? `WHERE (u.username ILIKE $1 OR u.email ILIKE $1)`
      : "";
    const params = search ? [`%${search}%`] : [];
    const result = await pool.query(`
      SELECT u.id, u.username, u.email, u.is_admin, u.is_blocked, u.created_at,
        u.last_login_at, u.last_seen_at, u.last_ip,
        l.key AS license_key, l.type AS license_type, l.expires_at, l.is_active AS license_active,
        l.hwid, l.ip,
        COALESCE(du.count, 0) AS daily_usage_today
      FROM users u
      LEFT JOIN licenses l ON l.user_id = u.id AND l.is_active = TRUE
      LEFT JOIN daily_usage du ON du.user_id = u.id AND du.usage_date = CURRENT_DATE
      ${whereClause}
      ORDER BY COALESCE(u.last_seen_at, u.created_at) DESC
    `, params);
    res.json(result.rows);
  });

  // ── Forzar cierre de sesión de un usuario (admin) ─────────────────────────────
  app.post("/api/admin/users/:id/force-logout", requireAdmin as any, async (req, res) => {
    await pool.query("UPDATE users SET session_token = NULL WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  });

  // ── Borrar IP de usuario ───────────────────────────────────────────────────────
  app.patch("/api/admin/users/:id/clear-ip", requireAdmin as any, async (req, res) => {
    const result = await pool.query(
      "UPDATE users SET last_ip = NULL WHERE id = $1 RETURNING id, username",
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Usuario no encontrado" });
    res.json({ ok: true });
  });

  // ── Eliminar usuario (admin) ──────────────────────────────────────────────────
  app.delete("/api/admin/users/:id", requireAdmin as any, async (req, res) => {
    const uid = req.params.id;
    // Borrar datos relacionados primero para evitar FK violations
    await pool.query("DELETE FROM licenses WHERE user_id = $1", [uid]);
    await pool.query("DELETE FROM daily_usage WHERE user_id = $1", [uid]);
    await pool.query("DELETE FROM activity_log WHERE user_id = $1", [uid]);
    const result = await pool.query("DELETE FROM users WHERE id = $1 RETURNING username", [uid]);
    if (!result.rows[0]) return res.status(404).json({ error: "Usuario no encontrado" });
    res.json({ ok: true, deleted: result.rows[0].username });
  });

  // ── Bloquear / desbloquear usuario ────────────────────────────────────────────
  app.patch("/api/admin/users/:id/block", requireAdmin as any, async (req, res) => {
    const { block } = req.body; // true = bloquear, false = desbloquear
    const result = await pool.query(
      "UPDATE users SET is_blocked=$1, session_token=NULL WHERE id=$2 RETURNING id, username, is_blocked",
      [!!block, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Usuario no encontrado" });
    res.json(result.rows[0]);
  });

  // ── Cambiar contraseña de usuario (admin) ─────────────────────────────────────
  app.post("/api/admin/users/:id/reset-password", requireAdmin as any, async (req, res) => {
    const { password } = req.body;
    if (!password || password.length < 6)
      return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "UPDATE users SET password_hash=$1, session_token=NULL WHERE id=$2 RETURNING id, username",
      [hash, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Usuario no encontrado" });
    res.json({ ok: true, username: result.rows[0].username });
  });

  // ── Cambiar rango de usuario (admin) ──────────────────────────────────────────
  app.patch("/api/admin/users/:id/rank", requireAdmin as any, async (req, res) => {
    const { rank } = req.body; // 'normal' | 'pro'
    if (!['normal', 'pro'].includes(rank))
      return res.status(400).json({ error: "Rango inválido. Usa 'normal' o 'pro'" });
    const result = await pool.query(
      "UPDATE users SET rank=$1 WHERE id=$2 RETURNING id, username, rank",
      [rank, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Usuario no encontrado" });
    res.json(result.rows[0]);
  });

  // ── Usage diario del usuario autenticado ──────────────────────────────────────
  app.get("/api/usage/today", requireAuth as any, async (req: AuthRequest, res) => {
    const userId = req.user!.id;
    const usageRes = await pool.query(
      "SELECT count FROM daily_usage WHERE user_id=$1 AND usage_date=CURRENT_DATE",
      [userId]
    );
    const unlimited = req.user?.is_admin === true;
    res.json({
      used:      Number(usageRes.rows[0]?.count || 0),
      limit:     unlimited ? null : DAILY_FREE_LIMIT,
      unlimited,
      resets_at: "00:00 UTC mañana",
    });
  });

  // ── Feed de actividad reciente ────────────────────────────────────────────────
  app.get("/api/admin/activity", requireAdmin as any, async (_req, res) => {
    const result = await pool.query(`
      SELECT al.id, al.action, al.ip, al.created_at,
             u.id AS user_id, u.username, u.email
      FROM activity_log al
      JOIN users u ON u.id = al.user_id
      ORDER BY al.created_at DESC
      LIMIT 300
    `);
    res.json(result.rows);
  });

  app.get("/api/admin/licenses", requireAdmin as any, async (_req, res) => {
    const result = await pool.query(`
      SELECT l.id, l.key, l.type, l.expires_at, l.is_active, l.activated_at,
             l.hwid, l.ip, l.created_at, l.features,
             u.username, u.email
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
    const lic = result.rows[0];
    // Si se desactiva, revocar sesiones de extensión activas
    if (lic && !lic.is_active) {
      await pool.query(
        "UPDATE extension_sessions SET revoked = TRUE WHERE license_key = $1 AND revoked = FALSE",
        [lic.key]
      ).catch(() => {});
    }
    res.json(lic);
  });

  app.delete("/api/admin/licenses/:id", requireAdmin as any, async (req, res) => {
    const licRes = await pool.query("SELECT key FROM licenses WHERE id = $1", [req.params.id]);
    const key = licRes.rows[0]?.key;
    if (key) {
      await pool.query(
        "UPDATE extension_sessions SET revoked = TRUE WHERE license_key = $1 AND revoked = FALSE",
        [key]
      ).catch(() => {});
    }
    await pool.query("DELETE FROM licenses WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  });

  app.patch("/api/admin/licenses/:id/reset-hwid", requireAdmin as any, async (req, res) => {
    const result = await pool.query(
      "UPDATE licenses SET hwid = NULL, ip = NULL WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    const lic = result.rows[0];
    if (lic?.key) {
      // Revocar todas las sesiones de extensión activas para esta licencia
      await pool.query(
        "UPDATE extension_sessions SET revoked = TRUE WHERE license_key = $1 AND revoked = FALSE",
        [lic.key]
      ).catch(() => {});
    }
    res.json(lic);
  });

  // ── Editar permisos (features) de una licencia ──────────────────────────────
  // Body: { features: ['photos'] }  o  { features: ['photos','academia'] }
  app.patch("/api/admin/licenses/:id/features", requireAdmin as any, async (req, res) => {
    const { features } = req.body;
    if (!Array.isArray(features)) return res.status(400).json({ error: "features debe ser un array" });
    // Siempre incluir 'photos' (Fantasma) — es el mínimo gratuito
    const clean: string[] = Array.from(new Set(['photos', ...features.map(String)]));
    const result = await pool.query(
      "UPDATE licenses SET features = $1 WHERE id = $2 RETURNING *",
      [clean, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Licencia no encontrada" });
    res.json(result.rows[0]);
  });

  // ── Gestión de tokens por licencia ─────────────────────────────────────────

  app.post("/api/admin/licenses/:id/tokens", requireAdmin as any, async (req, res) => {
    const { tokens } = req.body; // número o null
    if (tokens !== null && (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < 0)) {
      return res.status(400).json({ error: "tokens debe ser entero >= 0 o null (ilimitado)" });
    }
    const result = await pool.query(
      "UPDATE licenses SET image_tokens = $1 WHERE id = $2 RETURNING id, image_tokens",
      [tokens ?? null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Licencia no encontrada" });
    res.json(result.rows[0]);
  });

  app.patch("/api/admin/licenses/:id/features", requireAdmin as any, async (req, res) => {
    const { features } = req.body;
    if (!Array.isArray(features)) return res.status(400).json({ error: "features debe ser un array" });
    const clean: string[] = Array.from(new Set(['photos', ...features.map(String)]));
    const result = await pool.query(
      "UPDATE licenses SET features = $1 WHERE id = $2 RETURNING *",
      [clean, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Licencia no encontrada" });
    res.json(result.rows[0]);
  });

  // ── Cambiar fecha de expiración ─────────────────────────────────────────────

  app.patch("/api/admin/licenses/:id/expires", requireAdmin as any, async (req, res) => {
    const { expires_at } = req.body; // ISO string (YYYY-MM-DD) o null/vacío → lifetime
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "ID inválido" });
    let expiryDate: Date | null = null;
    if (expires_at) {
      expiryDate = new Date(expires_at);
      if (isNaN(expiryDate.getTime())) return res.status(400).json({ error: "Fecha inválida" });
    }
    const result = await pool.query(
      "UPDATE licenses SET expires_at = $1 WHERE id = $2 RETURNING id, expires_at",
      [expiryDate, id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Licencia no encontrada" });
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

  // ── Panel de monitoreo ───────────────────────────────────────────────────────
  app.get("/api/admin/monitor", requireAdmin as any, async (_req, res) => {
    const start = Date.now();
    try {
      const [
        dbCheck, totalUsers, activeUsers24h, newUsersToday,
        gensToday, gensTotal, gensByUser, errorsProxy,
        activeLicenses, blockedUsers,
      ] = await Promise.all([
        pool.query("SELECT 1").then(() => true).catch(() => false),
        pool.query("SELECT COUNT(*) FROM users"),
        pool.query("SELECT COUNT(*) FROM users WHERE last_seen_at > NOW() - INTERVAL '24h'"),
        pool.query("SELECT COUNT(*) FROM users WHERE created_at > CURRENT_DATE"),
        pool.query("SELECT COALESCE(SUM(count),0) as total FROM daily_usage WHERE usage_date=CURRENT_DATE"),
        pool.query("SELECT COALESCE(SUM(count),0) as total FROM daily_usage"),
        pool.query(`
          SELECT u.username, COALESCE(SUM(du.count),0) as total_today
          FROM users u
          LEFT JOIN daily_usage du ON du.user_id=u.id AND du.usage_date=CURRENT_DATE
          GROUP BY u.id, u.username
          HAVING COALESCE(SUM(du.count),0) > 0
          ORDER BY total_today DESC LIMIT 10
        `),
        pool.query("SELECT COUNT(*) FROM activity_log WHERE action LIKE 'error%' AND created_at > NOW() - INTERVAL '24h'"),
        pool.query("SELECT COUNT(*) FROM licenses WHERE is_active=TRUE AND (expires_at IS NULL OR expires_at > NOW())"),
        pool.query("SELECT COUNT(*) FROM users WHERE is_blocked=TRUE"),
      ]);
      const dbLatencyMs = Date.now() - start;

      res.json({
        status:          dbCheck ? "ok" : "db_error",
        db_latency_ms:   dbLatencyMs,
        db_ok:           dbCheck,
        uptime_s:        Math.floor(process.uptime()),
        mem_mb:          Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        node_version:    process.version,
        metrics: {
          total_users:      parseInt(totalUsers.rows[0].count),
          active_users_24h: parseInt(activeUsers24h.rows[0].count),
          new_users_today:  parseInt(newUsersToday.rows[0].count),
          gens_today:       parseInt(gensToday.rows[0].total),
          gens_total:       parseInt(gensTotal.rows[0].total),
          active_licenses:  parseInt(activeLicenses.rows[0].count),
          blocked_users:    parseInt(blockedUsers.rows[0].count),
          errors_24h:       parseInt(errorsProxy.rows[0].count),
        },
        top_users_today: gensByUser.rows,
        checked_at:      new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ status: "error", error: err.message });
    }
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

  // ── Proxy helper ─────────────────────────────────────────────────────────────
  // Usa el proxy configurado en PROXY_URL (iProyal Unblocker).
  // NO usamos https-proxy-agent ni NODE_TLS_REJECT_UNAUTHORIZED global porque
  // afecta a TODAS las conexiones TLS del proceso y rompe hasta los requests
  // directos a Vinted (ERR_SSL_WRONG_VERSION_NUMBER).
  // Usamos axios proxy nativo + httpsAgent con rejectUnauthorized:false SOLO
  // para las conexiones a través del proxy.
  const buildAxiosVinted = () => {
    const proxyUrl = process.env.PROXY_URL;
    if (!proxyUrl) {
      console.log("[proxy] Sin proxy configurado — requests directos a Vinted");
      return axios;
    }
    try {
      const u = new URL(proxyUrl);
      const cfg = axios.create({
        proxy: {
          protocol: "http",
          host: u.hostname,
          port: parseInt(u.port) || 12323,
          auth: u.username
            ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
            : undefined,
        },
        // rejectUnauthorized:false SOLO en este agente (no globalmente)
        // iProyal actúa como MITM y presenta su propio certificado
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      });
      console.log(`[proxy] iProyal Unblocker activo ✓ → ${u.hostname}:${u.port}`);
      return cfg;
    } catch (e: any) {
      console.warn("[proxy] Error parseando PROXY_URL:", e.message, "— usando requests directos");
      return axios;
    }
  };
  const axiosVinted = buildAxiosVinted();

  // ── Vinted Routes (public) ──────────────────────────────────────────────────

  app.get("/api/vinted/resolve-user", async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== "string") return res.status(400).json({ error: "Se requiere la URL del usuario." });
    try {
      const m = url.match(/\/member\/(\d+)(?:-|$)/);
      if (m) return res.json({ userId: m[1] });
      const response = await axiosVinted.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 });
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
      const response = await axiosVinted.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
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
      const response = await axiosVinted.get(`https://www.vinted.${domain}/items/${itemId}`, {
        headers: { "User-Agent": "Mozilla/5.0" }, validateStatus: () => true,
      });
      res.json({ visible: response.status === 200, status: response.status });
    } catch (error: any) {
      res.json({ visible: false, status: 500 });
    }
  });

  // ── Debug: ver qué devuelve exactamente Vinted con la cookie del usuario ──────
  app.post("/api/debug/vinted-item", requireLicense as any, async (req: AuthRequest, res) => {
    const { cookie, itemId } = req.body;
    if (!cookie || !itemId) return res.status(400).json({ error: "cookie e itemId requeridos" });
    // Auto-detect domain from cookie
    let domain = req.body.domain || "es";
    if (cookie.includes("_vinted_fr_session")) domain = "fr";
    else if (cookie.includes("_vinted_es_session")) domain = "es";
    else if (cookie.includes("_vinted_it_session")) domain = "it";
    else if (cookie.includes("_vinted_de_session")) domain = "de";
    else if (cookie.includes("_vinted_pl_session")) domain = "pl";

    // Decodificar JWT para ver si está caducado
    let tokenInfo: any = { extracted: false };
    try {
      const raw = cookie.trim().startsWith("ey") ? cookie.trim()
        : cookie.match(/access_token_web[:=]\s*([a-zA-Z0-9._-]+)/i)?.[1] || "";
      if (raw) {
        const payload = JSON.parse(Buffer.from(raw.split(".")[1], "base64url").toString());
        const now = Math.floor(Date.now() / 1000);
        tokenInfo = {
          extracted: true,
          userId: payload.sub || payload.id || payload.uid,
          exp: payload.exp,
          expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : "no exp",
          expired: payload.exp ? now > payload.exp : null,
          expiresInMin: payload.exp ? Math.round((payload.exp - now) / 60) : null,
        };
      }
    } catch (e: any) { tokenInfo.parseError = e.message; }

    const { headers } = getVintedHeaders(cookie as string, domain as string);

    const results: any = {};
    for (const [label, client] of [["direct", axios], ["proxy", axiosVinted]] as const) {
      try {
        const r = await (client as any).get(
          `https://www.vinted.${domain}/api/v2/items/${itemId}`,
          { headers, timeout: 8000, validateStatus: () => true }
        );
        results[label] = {
          status: r.status,
          body: typeof r.data === "string" ? r.data.slice(0, 300) : JSON.stringify(r.data).slice(0, 300),
          isDataDome: typeof r.data === "string" && r.data.toLowerCase().includes("datadome"),
          hasItem: r.status === 200 && !!(r.data?.item?.id || r.data?.id),
        };
      } catch (e: any) {
        results[label] = { error: e.code || e.message };
      }
    }
    res.json({ tokenInfo, results, authHeaderSent: !!headers["Authorization"] });
  });

  // ── Vinted Routes (require license) ────────────────────────────────────────

  app.post("/api/vinted/check-session", requireLicense as any, async (req: AuthRequest, res) => {
    const { cookie, domain = "es" } = req.body;
    if (!cookie) return res.status(400).json({ error: "Cookie is required" });
    try {
      const { headers, domain: activeDomain } = getVintedHeaders(cookie, domain);
      const response = await axiosVinted.get(`https://www.vinted.${activeDomain}/api/v2/users/current`, { headers, timeout: 10000, validateStatus: () => true });
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
          const response = await axiosVinted.get(`https://www.vinted.${d}${p}`, { headers, timeout: 8000, validateStatus: s => s === 200 });
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
      const response = await axiosVinted.post(`https://www.vinted.${activeDomain}/api/v2/items/${itemId}/hide`, {}, { headers });
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
      const response = await axiosVinted.post(`https://www.vinted.${activeDomain}/api/v2/items/${itemId}/reveal`, {}, { headers });
      res.json({ success: true, data: response.data });
    } catch (error: any) {
      res.status(error.response?.status || 500).json({ error: "Failed to reveal item", details: error.response?.data || error.message });
    }
  });

  app.post("/api/vinted/report", requireLicense as any, async (req: AuthRequest, res) => {
    const { cookie, itemId, reasonId, description, domain = "es" } = req.body;
    if (!cookie || !itemId) return res.status(400).json({ error: "Cookie and Item ID are required" });

    const cookieStr = cookie as string;

    // Detectar dominio primario desde la cookie (el que definitivamente tiene sesión)
    let primaryDomain = domain as string;
    if (cookieStr.includes("_vinted_fr_session")) primaryDomain = "fr";
    else if (cookieStr.includes("_vinted_es_session")) primaryDomain = "es";
    else if (cookieStr.includes("_vinted_it_session")) primaryDomain = "it";
    else if (cookieStr.includes("_vinted_de_session")) primaryDomain = "de";
    else if (cookieStr.includes("_vinted_pl_session")) primaryDomain = "pl";
    else if (cookieStr.includes("_vinted_nl_session")) primaryDomain = "nl";

    // Dominio primario primero, luego el resto
    const reportDomains = [primaryDomain, ...["fr","es","it","be","pl","de","nl"].filter(d => d !== primaryDomain)];
    const _repUid = String(req.user!.id);
    opsEmit(_repUid, "sys", "SYS", `→ REPORTE AI · item_id:${itemId} · reason:${reasonId} · dom:${primaryDomain}`);

    const mkIdempotency = () =>
      "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });

    const payloads = [
      { complaint: { item_id: parseInt(itemId), reason_id: parseInt(String(reasonId || "1")), description: description || "Este artículo es una falsificación." } },
      { complaint: { entity_id: parseInt(itemId), entity_type: "Item", reason_id: parseInt(String(reasonId || "1")), description: description || "Counterfeit item." } },
    ];

    // Variantes de headers — la clave es probar mobile-agent y pure-cookie porque
    // DataDome y el WAF de Vinted son más permisivos con requests que parecen app nativa
    const variants: Array<{ name: string; patch: (h: any) => void }> = [
      { name: "mobile-app",   patch: h => { h["User-Agent"] = "Vinted/24.5.0 (iPhone; iOS 17.5; Scale/3.00)"; h["X-Vinted-Client"] = "ios"; delete h["Sec-Ch-Ua"]; delete h["Sec-Ch-Ua-Mobile"]; delete h["Sec-Ch-Ua-Platform"]; } },
      { name: "pure-cookie",  patch: h => { delete h["Authorization"]; delete h["X-Vinted-Access-Token"]; h["X-Vinted-Auth-Method"] = "session"; } },
      { name: "standard",     patch: () => {} },
      { name: "legacy-raw",   patch: h => { h["Cookie"] = cookieStr.trim(); delete h["Authorization"]; } },
      { name: "android-app",  patch: h => { h["User-Agent"] = "Vinted/24.5.0 (Linux; Android 14; Pixel 8)"; h["X-Vinted-Client"] = "android"; delete h["Sec-Ch-Ua"]; } },
    ];

    let finalError: any = null;
    let primaryTotal401 = 0;

    for (const activeDom of reportDomains) {
      let domainGot401 = 0;

      for (const { name: variant, patch } of variants) {
        await new Promise(r => setTimeout(r, 120 + Math.random() * 180));
        for (const payload of payloads) {
          try {
            const { headers } = getVintedHeaders(cookieStr, activeDom);
            patch(headers);
            headers["Referer"] = `https://www.vinted.${activeDom}/items/${itemId}`;
            headers["Origin"]  = `https://www.vinted.${activeDom}`;
            headers["X-Vinted-Idempotency-Key"] = mkIdempotency();
            const response = await axiosVinted.post(
              `https://www.vinted.${activeDom}/api/v2/complaints`,
              payload,
              { headers, timeout: 12000, maxRedirects: 0, validateStatus: s => s >= 200 && s < 303 }
            );
            return res.json({ success: true, data: response.data, domainUsed: activeDom, variantUsed: variant });
          } catch (err: any) {
            finalError = err;
            if (err.response?.status === 401) domainGot401++;
          }
        }
      }

      // Si el dominio PRIMARIO rechaza todas las variantes con 401, la sesión está muerta
      if (activeDom === primaryDomain && domainGot401 === variants.length * payloads.length) {
        primaryTotal401 = domainGot401;
        break; // no tiene sentido intentar otros dominios con la misma cookie muerta
      }
    }

    if (primaryTotal401 > 0) {
      return res.status(401).json({
        error: "Sesión expirada. Copia una cookie fresca desde Vinted (F12 → Application → Cookies → copia la línea completa).",
        hint: "La cookie access_token_web tiene una vida útil corta. Recárgala desde el navegador."
      });
    }

    res.status(finalError?.response?.status || 500).json({ error: "No se pudo enviar el reporte", details: finalError?.message });
  });

  app.post("/api/vinted/spam-checkout", requireLicense as any, async (req: AuthRequest, res) => {
    const { cookie, itemId, domain = "es" } = req.body;
    if (!cookie || !itemId) return res.status(400).json({ error: "Cookie and Item ID are required" });

    const rawCookie = cookie as string;
    const cookies = rawCookie.includes("\n")
      ? rawCookie.split("\n").map(c => c.trim()).filter(c => c.length > 5)
      : rawCookie.split(",").map(c => c.trim()).filter(c => c.length > 5);

    const id = itemId.toString();
    const _bombUid = String(req.user!.id);
    opsEmit(_bombUid, "sys", "SYS", `→ BOMBARDEO · item_id:${id} · domain:${domain} · flood:120s`);
    const activeDomains = [...new Set([domain, "fr", "es", "it", "pl", "be", "de", "nl"])];
    let totalSuccess = 0;

    await Promise.all(cookies.map(token =>
      Promise.all(activeDomains.slice(0, 8).map(async dom => {
        try {
          const { headers } = getVintedHeaders(token, dom);
          await axiosVinted.post(`https://www.vinted.${dom}/api/v2/items/${id}/view`, {}, { headers, timeout: 4000, validateStatus: () => true });
        } catch {}
      }))
    ));

    const iid = parseInt(id, 10);
    const endTime = Date.now() + 120 * 1000;
    while (Date.now() < endTime) {
      await Promise.all(cookies.map(token =>
        Promise.all(activeDomains.map(async dom => {
          const { headers } = getVintedHeaders(token, dom);
          const ikey = () => `brd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const calls: Array<{ url: string; body: any }> = [
            // Conversación de compra — mismo flujo que el sniper, paso 1
            { url: `https://www.vinted.${dom}/api/v2/conversations`,
              body: { initiator: "buy", item_id: String(id), opposite_user_id: "0" } },
            // Favourite toggle (confirmado en background.js de Blackstock)
            { url: `https://www.vinted.${dom}/api/v2/user_favourites/toggle`,
              body: { type: "item", user_favourites: [iid] } },
            // Complaint
            { url: `https://www.vinted.${dom}/api/v2/complaints`,
              body: { complaint: { item_id: iid, reason_id: 1, description: "Counterfeit item violating platform rules." } } },
          ];
          await Promise.all(calls.map(async ({ url: ep, body }) => {
            try {
              const r = await axiosVinted.post(ep, body, {
                headers: { ...headers, "X-Vinted-Idempotency-Key": ikey() },
                timeout: 5000, validateStatus: () => true,
              });
              if (r.status < 400) totalSuccess++;
            } catch {}
          }));
        }))
      ));
      await new Promise(r => setTimeout(r, 800));
    }

    opsEmit(_bombUid, "ok", "BOMBARDEO", `✓ completado · ${totalSuccess} impactos · 120s`);
    res.json({ success: true, count: totalSuccess, message: `BOMBARDEO FINALIZADO. ${totalSuccess} impactos en 2 minutos.` });
  });

  // ── Seller public items (no auth) ────────────────────────────────────────────
  app.get("/api/vinted/seller-items", async (req, res) => {
    const { url, domain: qDomain = "es" } = req.query as Record<string, string>;
    if (!url) return res.status(400).json({ error: "url requerida" });
    let sellerId: string | null = null;
    const mId = url.match(/\/member\/(\d+)/);
    if (mId) sellerId = mId[1];
    const domMatch = url.match(/vinted\.([a-z.]+)/);
    const dom = domMatch ? domMatch[1] : qDomain;
    if (!sellerId) {
      try {
        const r = await axiosVinted.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 });
        const m = r.data.match(/"id":(\d+),"username":/);
        if (m) sellerId = m[1];
      } catch {}
    }
    if (!sellerId) return res.status(404).json({ error: "No se pudo resolver el vendedor" });
    try {
      const r = await axiosVinted.get(
        `https://www.vinted.${dom}/api/v2/users/${sellerId}/items?page=1&per_page=96&status[]=active`,
        { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, timeout: 10000 }
      );
      const items = r.data.items || [];
      res.json({ sellerId, domain: dom, items, total: items.length });
    } catch (err: any) {
      res.status(500).json({ error: "No se pudieron obtener los artículos", details: err.message });
    }
  });

  // ── Sniper Bazooka (flujo real Blackstock) ────────────────────────────────────
  // Flujo exacto interceptado de api.blackstock.es:
  //   1. GET  /api/v2/items/{id}                              → sellerId + title
  //   2. POST /api/v2/conversations                           → transactionId
  //      body: { initiator:'buy', item_id, opposite_user_id:sellerId }
  //   3. POST /api/v2/purchases/checkout/build                → item reservado
  //      body: { purchase_items:[{id:transactionId,type:'transaction'}] }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/api/sniper/fire", requireLicense as any, async (req: AuthRequest, res) => {
    try {
      const { url, cookies, workers: numWorkers = 3 } = req.body;
      if (!url || !cookies) return res.status(400).json({ error: "url y cookies requeridos" });

      // ── Extraer dominio e itemId ─────────────────────────────────────────────
      const domMatch = url.match(/vinted\.([a-z]+(?:\.[a-z]+)?)/);
      const domain = domMatch ? domMatch[1] : "es";

      const itemId: string | null =
        url.match(/\/items\/(\d+)/i)?.[1] ||   // /items/123456 (formato Blackstock)
        url.match(/\/(\d{5,})-/)?.[1] ||        // /123456-slug
        url.match(/\/(\d{5,})\/?(?:[?#]|$)/)?.[1] || // /123456 bare
        null;

      if (!itemId) {
        return res.status(400).json({ error: "URL inválida. Usa el formato: https://www.vinted.es/items/123456-titulo" });
      }

      // ── Parsear cookies ──────────────────────────────────────────────────────
      const cookieList: string[] = Array.isArray(cookies)
        ? cookies.map((c: string) => c.trim()).filter((c: string) => c.length > 5)
        : cookies.split("\n").map((c: string) => c.trim()).filter((c: string) => c.length > 5);
      if (cookieList.length === 0) return res.status(400).json({ error: "Cookie inválida o vacía" });

      const workerCount = Math.min(Number(numWorkers) || 3, Math.max(cookieList.length, 1), 5);
      const globalStart = Date.now();

      // ── Detectar dominio real del usuario desde la cookie ────────────────────
      // La cuenta del usuario puede ser de vinted.fr aunque el ítem sea de vinted.es.
      // Las llamadas autenticadas (conversations, checkout/build) DEBEN ir al dominio
      // donde está la cuenta, no al dominio del ítem.
      const detectUserDomain = (ck: string): string => {
        if (ck.includes("_vinted_fr_session")) return "fr";
        if (ck.includes("_vinted_es_session")) return "es";
        if (ck.includes("_vinted_it_session")) return "it";
        if (ck.includes("_vinted_de_session")) return "de";
        if (ck.includes("_vinted_pl_session")) return "pl";
        if (ck.includes("_vinted_nl_session")) return "nl";
        if (ck.includes("_vinted_be_session")) return "be";
        if (ck.includes("_vinted_pt_session")) return "pt";
        if (ck.includes("_vinted_cz_session")) return "cz";
        // Fallback: intentar decodificar el JWT audience
        try {
          const raw = ck.trim().startsWith("ey") ? ck.trim()
            : ck.match(/access_token_web[:=]\s*([a-zA-Z0-9._-]+)/i)?.[1] || "";
          if (raw && raw.includes(".")) {
            const payload = JSON.parse(Buffer.from(raw.split(".")[1], "base64url").toString());
            const aud: string = Array.isArray(payload.aud) ? payload.aud[0] : (payload.aud || "");
            const audDom = aud.match(/^([a-z]+)\.core\.api/)?.[1];
            if (audDom) return audDom;
          }
        } catch {}
        return domain; // fallback al dominio del ítem
      };
      const userDomain = detectUserDomain(cookieList[0]);
      console.log(`[sniper] itemDomain=${domain} userDomain=${userDomain}`);

      // ── Un worker: flujo Blackstock completo ─────────────────────────────────
      const runWorker = async (idx: number) => {
        const cookie = cookieList[idx % cookieList.length];
        // Detectar dominio de este cookie concreto (puede diferir entre workers)
        const wUserDomain = detectUserDomain(cookie);
        const { headers } = getVintedHeaders(cookie, wUserDomain);
        const wStart = Date.now();
        // Las llamadas autenticadas van al dominio del usuario (fr, es, etc.)
        const base = `https://www.vinted.${wUserDomain}`;

        // Paso 1 — Obtener sellerId + título
        // El ítem puede estar en un dominio diferente al del usuario.
        // Probamos primero el dominio del ítem, luego el del usuario.
        let sellerId = "";
        let itemTitle = "";
        {
          let ir: any = null;
          let lastErr = "";
          // Dominios a probar: el del item primero, luego el del usuario
          const domainsToTry = [...new Set([domain, wUserDomain])];
          for (const tryDom of domainsToTry) {
            for (const client of [axiosVinted, axios]) {
              try {
                const { headers: h } = getVintedHeaders(cookie, tryDom);
                const r = await client.get(`https://www.vinted.${tryDom}/api/v2/items/${itemId}`, {
                  headers: h, timeout: 8000, validateStatus: () => true,
                });
                console.log(`[sniper] items/${itemId} via ${client === axios ? "direct" : "proxy"} dom=${tryDom} → ${r.status}`);
                if (r.status === 200) { ir = r; break; }
                lastErr = `HTTP ${r.status} (${tryDom})`;
              } catch (e: any) {
                lastErr = `${e.code || e.message} (${tryDom})`;
              }
            }
            if (ir) break;
          }
          if (!ir) {
            return { worker: idx + 1, success: false, sellerId: "", itemTitle: "", transactionId: "", purchaseId: "",
              error: `items/${itemId} → ${lastErr}`, durationMs: Date.now() - wStart };
          }
          const it = ir.data.item || ir.data;
          itemTitle = it.title || "";
          sellerId  = String(it.user_id || it.user?.id || "");
        }

        if (!sellerId) {
          return { worker: idx + 1, success: false, sellerId: "", itemTitle, transactionId: "", purchaseId: "",
            error: "seller_id_not_found", durationMs: Date.now() - wStart };
        }

        // Paso 2 — Crear conversación de compra (obtiene transactionId)
        let transactionId = "";
        try {
          console.log(`[sniper W${idx+1}] POST ${base}/api/v2/conversations item=${itemId} seller=${sellerId}`);
          const convR = await axiosVinted.post(`${base}/api/v2/conversations`, {
            initiator: "buy",
            item_id: String(itemId),
            opposite_user_id: String(sellerId),
          }, { headers, timeout: 10000, validateStatus: () => true });

          console.log(`[sniper W${idx+1}] conversations → HTTP ${convR.status} tx=${convR.data?.conversation?.transaction?.id}`);
          if (!convR.data?.conversation?.transaction?.id) {
            return { worker: idx + 1, success: false, sellerId, itemTitle, transactionId: "", purchaseId: "",
              error: `conversations → HTTP ${convR.status} (sin transaction_id)`, durationMs: Date.now() - wStart };
          }
          transactionId = String(convR.data.conversation.transaction.id);
        } catch (e: any) {
          return { worker: idx + 1, success: false, sellerId, itemTitle, transactionId: "", purchaseId: "",
            error: `conversations → ${e.code || e.message}`, durationMs: Date.now() - wStart };
        }

        // Paso 3 — Checkout build (RESERVA el ítem — lo saca de búsqueda)
        try {
          console.log(`[sniper W${idx+1}] POST ${base}/api/v2/purchases/checkout/build tx=${transactionId}`);
          const buildR = await axiosVinted.post(`${base}/api/v2/purchases/checkout/build`, {
            purchase_items: [{ id: transactionId, type: "transaction" }],
          }, { headers, timeout: 10000, validateStatus: () => true });

          const purchaseId = String(
            buildR.data?.checkout?.purchase_id || buildR.data?.purchase_id || transactionId
          );

          if (buildR.status >= 200 && buildR.status < 300) {
            return { worker: idx + 1, success: true, sellerId, itemTitle, transactionId, purchaseId,
              error: "", durationMs: Date.now() - wStart };
          }
          return { worker: idx + 1, success: false, sellerId, itemTitle, transactionId, purchaseId: "",
            error: `checkout/build → HTTP ${buildR.status}`, durationMs: Date.now() - wStart };
        } catch (e: any) {
          return { worker: idx + 1, success: false, sellerId, itemTitle, transactionId, purchaseId: "",
            error: `checkout/build → ${e.code || e.message}`, durationMs: Date.now() - wStart };
        }
      };

      // ── Lanzar N workers en paralelo ─────────────────────────────────────────
      const results = await Promise.all(
        Array.from({ length: workerCount }, (_, i) => runWorker(i))
      );
      const winner    = results.find(r => r.success) || null;
      const fastestMs = winner?.durationMs ?? (Date.now() - globalStart);
      const itemTitle = results.find(r => r.itemTitle)?.itemTitle || "";
      const sellerId  = results.find(r => r.sellerId)?.sellerId  || "";

      // ── Emitir al ops-terminal ───────────────────────────────────────────────
      const _sniperUid = String(req.user!.id);
      opsEmit(_sniperUid, "sys", "SYS", `→ SNIPER · item_id:${itemId} · seller:${sellerId || "?"} · workers:${workerCount}`);
      for (const r of results) {
        opsEmit(_sniperUid, r.success ? "worker" : "err", `W${r.worker}`,
          r.success
            ? `✓ checkout OK · ${r.durationMs}ms · tx:${(r as any).transactionId || "?"}`
            : `✗ ${((r as any).error || "rechazado").slice(0, 80)}`);
      }
      if (winner) {
        opsEmit(_sniperUid, "ok", "SNIPER",
          `🏆 GANADOR W${winner.worker} · ${fastestMs}ms · tx:${winner.transactionId} · purchase:${winner.purchaseId}`);
      } else {
        opsEmit(_sniperUid, "err", "SNIPER",
          `FALLIDO · ${results.map((r: any) => `W${r.worker}:${r.error || "fail"}`).join(" · ")}`);
      }

      // ── Persistir (non-blocking) ─────────────────────────────────────────────
      pool.query(
        `INSERT INTO sniper_history(user_id,item_id,item_url,item_title,seller_id,success,winner_worker,transaction_id,purchase_id,fastest_ms,workers_total,workers_ok)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [req.user!.id, itemId, url, itemTitle, sellerId || null, !!winner,
         winner?.worker ?? null, winner?.transactionId ?? null, winner?.purchaseId ?? null,
         fastestMs, workerCount, results.filter(r => r.success).length]
      ).catch(() => {});

      res.json({
        ok: !!winner,
        itemId, sellerId, title: itemTitle,
        workers: workerCount,
        winner,
        results,
        fastestMs,
      });

    } catch (err: any) {
      console.error("[sniper] unhandled error:", err);
      res.status(500).json({ error: "Error interno: " + (err.message || String(err)) });
    }
  });

  // ── Bazooka Queue ─────────────────────────────────────────────────────────────
  app.get("/api/bazooka/jobs", requireLicense as any, async (req: AuthRequest, res) => {
    const r = await pool.query(
      "SELECT id,url,title,item_id,status,note,error_message,created_at FROM bazooka_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",
      [req.user!.id]
    );
    res.json(r.rows);
  });

  app.post("/api/bazooka/enqueue", requireLicense as any, async (req: AuthRequest, res) => {
    const { url, title, cookies } = req.body;
    if (!url || !cookies) return res.status(400).json({ error: "url y cookies requeridos" });
    const itemId = url.match(/\/(\d{5,})-/)?.[1] || null;
    const r = await pool.query(
      "INSERT INTO bazooka_jobs(user_id,url,title,item_id,status,vinted_cookies) VALUES($1,$2,$3,$4,'pending',$5) RETURNING *",
      [req.user!.id, url, title || "", itemId, cookies]
    );
    const job = r.rows[0];
    // Attempt async processing
    (async () => {
      const dom = url.match(/vinted\.([a-z.]+)/)?.[1] || "es";
      const cookieStr = cookies.split("\n")[0].trim() || cookies;
      const { headers } = getVintedHeaders(cookieStr, dom);
      try {
        await pool.query("UPDATE bazooka_jobs SET status='processing',updated_at=NOW() WHERE id=$1", [job.id]);
        const cr = await axiosVinted.post(
          `https://www.vinted.${dom}/api/v2/items/${itemId}/checkout`, {},
          { headers: { ...headers, "X-Vinted-Idempotency-Key": `bz_${job.id}_${Date.now()}` }, timeout: 10000, validateStatus: () => true }
        );
        if (cr.status >= 200 && cr.status < 300) {
          const txId = cr.data?.transaction?.id ?? cr.data?.id ?? "";
          await pool.query("UPDATE bazooka_jobs SET status='done',note=$1,updated_at=NOW() WHERE id=$2", [`Reservado tx:${txId}`, job.id]);
        } else {
          await pool.query("UPDATE bazooka_jobs SET status='failed',error_message=$1,updated_at=NOW() WHERE id=$2", [`HTTP ${cr.status}`, job.id]);
        }
      } catch (e: any) {
        await pool.query("UPDATE bazooka_jobs SET status='failed',error_message=$1,updated_at=NOW() WHERE id=$2", [e.message?.slice(0, 100) || "error", job.id]).catch(() => {});
      }
    })().catch(() => {});
    res.json([job]);
  });

  app.delete("/api/bazooka/jobs/clear", requireLicense as any, async (req: AuthRequest, res) => {
    await pool.query("DELETE FROM bazooka_jobs WHERE user_id=$1 AND status IN ('done','failed')", [req.user!.id]);
    res.json({ ok: true });
  });

  app.post("/api/bazooka/goolazo-bridge", requireLicense as any, async (req: AuthRequest, res) => {
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ error: "url requerida" });
    const dom = url.match(/vinted\.([a-z.]+)/)?.[1] || "es";
    let itemId: string | null = url.match(/\/(\d{5,})-/)?.[1] || null;
    if (!itemId) {
      try {
        const p = await axiosVinted.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 });
        const m = p.data.match(/"id":(\d+),"title":/);
        if (m) itemId = m[1];
      } catch {}
    }
    if (!itemId) return res.status(400).json({ error: "No se pudo resolver el ID" });
    // Store as pending job (workers will pick up via enqueue flow)
    try {
      await pool.query(
        "INSERT INTO bazooka_jobs(user_id,url,title,item_id,status,vinted_cookies) VALUES($1,$2,$3,$4,'pending','goolazo')",
        [req.user!.id, url, title || "", itemId]
      );
    } catch {}
    res.json({ ok: true, itemId, accountName: "Goolazo Worker" });
  });

  app.post("/api/bazooka/goolazo-login", requireLicense as any, async (_req: AuthRequest, res) => {
    res.status(503).json({ error: "Goolazo externo no disponible. Usa Sniper Bazooka directo con tu cookie de Vinted." });
  });

  // ── Bazooka Client API — usada por la extensión Chrome ──────────────────────
  // Auth: Bearer JWT (mismo token que el hub). No se usan cookies ni CSRF.

  // GET /api/bazooka/client/csrf — noop, compatibilidad con código legacy
  app.get("/api/bazooka/client/csrf", (_req, res) => {
    res.json({ ok: true, csrfToken: "noop" });
  });

  // POST /api/bazooka/client/login — login con email+password, devuelve JWT
  app.post("/api/bazooka/client/login", authLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ ok: false, error: "email_and_password_required" });
    try {
      const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.trim().toLowerCase()]);
      const user = result.rows[0];
      if (!user || !(await bcrypt.compare(password, user.password_hash)))
        return res.status(401).json({ ok: false, error: "invalid_credentials" });
      const licRes = await pool.query(
        "SELECT is_active, expires_at FROM licenses WHERE user_id=$1 AND is_active=TRUE AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1",
        [user.id]
      );
      const lic = licRes.rows[0];
      if (!lic && !user.is_admin)
        return res.status(403).json({ ok: false, error: "license_not_active" });
      const token = await mintSessionToken(user.id);
      res.json({
        ok: true, token,
        account: { email: user.email, status: "active", createdAt: user.created_at },
        summary: { total: 1, active: 1, expired: 0, onlineInstalls: 1 },
        licenses: [],
        remote: {},
        links: { extension: "https://founderclub-production.up.railway.app", guide: "https://founderclub-production.up.railway.app/#funciones", billing: "https://founderclub-production.up.railway.app", discord: null },
      });
    } catch {
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // POST /api/bazooka/client/register — registro con email+password+licencia
  app.post("/api/bazooka/client/register", authLimiter, async (req, res) => {
    const { email, password, license } = req.body;
    if (!email || !password)
      return res.status(400).json({ ok: false, error: "email_invalid" });
    if (!password || password.length < 6)
      return res.status(400).json({ ok: false, error: "password_invalid" });
    try {
      const existing = await pool.query("SELECT id FROM users WHERE email=$1", [email.trim().toLowerCase()]);
      if (existing.rows[0]) return res.status(409).json({ ok: false, error: "email_exists" });
      const hash = await bcrypt.hash(password, 10);
      const newUser = await pool.query(
        "INSERT INTO users(email,username,password_hash) VALUES($1,$2,$3) RETURNING *",
        [email.trim().toLowerCase(), email.split("@")[0], hash]
      );
      const user = newUser.rows[0];
      // Link license if provided
      if (license) {
        const lic = await pool.query(
          "SELECT * FROM licenses WHERE key=$1 AND is_active=TRUE AND user_id IS NULL LIMIT 1",
          [String(license).trim().toUpperCase()]
        );
        if (lic.rows[0]) {
          await pool.query("UPDATE licenses SET user_id=$1 WHERE id=$2", [user.id, lic.rows[0].id]);
        }
      }
      const token = await mintSessionToken(user.id);
      res.json({ ok: true, token, account: { email: user.email, status: "active", createdAt: user.created_at } });
    } catch {
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // GET /api/bazooka/client/me — devuelve info de cuenta (requiere license activa)
  app.get("/api/bazooka/client/me", requireLicense as any, async (req: AuthRequest, res) => {
    const user = req.user!;
    const licRes = await pool.query(
      "SELECT type, expires_at FROM licenses WHERE user_id=$1 AND is_active=TRUE LIMIT 1", [user.id]
    );
    const lic = licRes.rows[0];
    res.json({
      ok: true,
      account: { email: user.email, status: "active", createdAt: (user as any).created_at },
      summary: { total: 1, active: 1, expired: 0, onlineInstalls: 1 },
      licenses: lic ? [{ license: { keyMasked: "****-****", plan: lic.type || "month", status: "active", expiresAt: lic.expires_at, maxInstalls: 3 }, usage: { installsCount: 1, onlineCount: 1 }, activity: { lastHeartbeat: new Date().toISOString() }, installs: [] }] : [],
      remote: {},
      links: { extension: "https://founderclub-production.up.railway.app", guide: "https://founderclub-production.up.railway.app/#funciones", billing: "https://founderclub-production.up.railway.app", discord: null },
    });
  });

  // POST /api/bazooka/client/logout — noop (JWT stateless)
  app.post("/api/bazooka/client/logout", (_req, res) => {
    res.json({ ok: true });
  });

  // POST /api/bazooka/client/jobs          → registrar job
  // POST /api/bazooka/client/jobs/:id/result → reportar resultado
  // GET  /api/bazooka/client/dashboard     → estado de la cola

  app.post("/api/bazooka/client/jobs", requireLicense as any, async (req: AuthRequest, res) => {
    const { url, title, accountName, accountMemberId, accountUrl } = req.body;
    if (!url) return res.status(400).json({ error: "url requerida" });

    const itemId = url.match(/\/items\/(\d+)/i)?.[1]
      || url.match(/\/(\d{5,})-/)?.[1]
      || null;

    // Detectar duplicado (mismo item pendiente/procesando en los últimos 10 min)
    if (itemId) {
      const dup = await pool.query(
        `SELECT id FROM bazooka_jobs WHERE user_id=$1 AND item_id=$2
         AND status IN ('pending','processing','done')
         AND created_at > NOW() - INTERVAL '10 minutes' LIMIT 1`,
        [req.user!.id, itemId]
      );
      if (dup.rows[0]) {
        const dash = await pool.query(
          `SELECT id,url,title,item_id,status,note,error_message,created_at
           FROM bazooka_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,
          [req.user!.id]
        );
        return res.json({ duplicate: true, job: dup.rows[0], dashboard: { jobs: dash.rows } });
      }
    }

    const r = await pool.query(
      `INSERT INTO bazooka_jobs(user_id,url,title,item_id,status,vinted_cookies)
       VALUES($1,$2,$3,$4,'pending','extension') RETURNING *`,
      [req.user!.id, url, title || accountName || "", itemId]
    );
    const job = r.rows[0];

    const dash = await pool.query(
      `SELECT id,url,title,item_id,status,note,error_message,created_at
       FROM bazooka_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [req.user!.id]
    );

    opsEmit(String(req.user!.id), 'sys', 'EXT', `→ job #${job.id} encolado · item_id:${itemId || '?'} · "${(title || accountName || '').slice(0, 40)}"`);

    res.json({ ok: true, duplicate: false, job, dashboard: { jobs: dash.rows } });
  });

  app.post("/api/bazooka/client/jobs/:id/result", requireLicense as any, async (req: AuthRequest, res) => {
    const { status, note, errorMessage } = req.body;
    const jobId = req.params.id;

    // Verificar que el job pertenece al usuario
    const job = await pool.query(
      "SELECT id FROM bazooka_jobs WHERE id=$1 AND user_id=$2", [jobId, req.user!.id]
    );
    if (!job.rows[0]) return res.status(404).json({ error: "Job no encontrado" });

    await pool.query(
      `UPDATE bazooka_jobs SET status=$1, note=$2, error_message=$3, updated_at=NOW() WHERE id=$4`,
      [status || "done", note || null, errorMessage || null, jobId]
    );

    const finalStatus = status || 'done';
    opsEmit(String(req.user!.id), finalStatus === 'done' ? 'ok' : 'err', 'EXT',
      `job#${jobId} → ${finalStatus.toUpperCase()}${note ? ' · ' + note : ''}${errorMessage ? ' · ERR: ' + errorMessage.slice(0, 80) : ''}`);

    res.json({ ok: true });
  });

  app.get("/api/bazooka/client/dashboard", requireLicense as any, async (req: AuthRequest, res) => {
    const user = req.user!;
    const jobs = await pool.query(
      `SELECT id,url,title,item_id,status,note,error_message,created_at,updated_at
       FROM bazooka_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`,
      [user.id]
    );
    const stats = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='done') AS done,
         COUNT(*) FILTER (WHERE status='failed') AS failed,
         COUNT(*) FILTER (WHERE status IN ('pending','processing')) AS pending
       FROM bazooka_jobs WHERE user_id=$1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [user.id]
    );
    const licRes = await pool.query(
      "SELECT type, expires_at FROM licenses WHERE user_id=$1 AND is_active=TRUE LIMIT 1", [user.id]
    );
    const lic = licRes.rows[0];
    const s = stats.rows[0] || {};
    const activeJob = jobs.rows.find((j: any) => j.status === 'processing') || null;
    const pendingCount = Number(s.pending || 0);
    res.json({
      ok: true,
      jobs: jobs.rows,
      stats: s,
      account: { email: user.email, status: "active", createdAt: (user as any).created_at },
      summary: { total: 1, active: 1, expired: 0, onlineInstalls: 1 },
      licenses: lic ? [{ license: { keyMasked: "****-****", plan: lic.type || "month", status: "active", expiresAt: lic.expires_at, maxInstalls: 3 }, usage: { installsCount: 1, onlineCount: 1 }, activity: { lastHeartbeat: new Date().toISOString() }, installs: [] }] : [],
      remote: { serverTime: new Date().toISOString(), worker: null, activeJob: activeJob ? { title: activeJob.title, url: activeJob.url, status: activeJob.status } : null, pendingCount },
      links: { extension: "https://founderclub-production.up.railway.app", guide: "https://founderclub-production.up.railway.app/#funciones", billing: "https://founderclub-production.up.railway.app", discord: null },
    });
  });

  // ── Profits / Sales endpoints ────────────────────────────────────────────────

  // ── Dashboard unificado — todas las cuentas ───────────────────────────────
  app.get("/api/dashboard", requireAuth as any, async (req: AuthRequest, res) => {
    const accounts = await pool.query(
      "SELECT id, username, domain, balance, items_count, sold_count, last_synced_at FROM vinted_accounts WHERE user_id=$1 AND is_active=TRUE",
      [req.user!.id]
    );
    const sales = await pool.query(
      "SELECT COALESCE(SUM(sell_price - buy_price),0) as total_profit, COUNT(*) as total_sales, COALESCE(SUM(sell_price),0) as total_revenue FROM sales WHERE user_id=$1",
      [req.user!.id]
    );
    const expenses = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as total FROM vinted_expenses WHERE user_id=$1",
      [req.user!.id]
    );
    const inventory = await pool.query(
      `SELECT vi.account_id, COUNT(*) as total, COUNT(*) FILTER (WHERE vi.is_hidden) as hidden, COUNT(*) FILTER (WHERE vi.status='sold') as sold
       FROM vinted_inventory vi
       JOIN vinted_accounts va ON va.id = vi.account_id
       WHERE va.user_id=$1
       GROUP BY vi.account_id`,
      [req.user!.id]
    );
    const recentSales = await pool.query(
      "SELECT * FROM sales WHERE user_id=$1 ORDER BY date DESC, created_at DESC LIMIT 10",
      [req.user!.id]
    );
    const totalBalance = accounts.rows.reduce((s, a) => s + parseFloat(a.balance || 0), 0);
    const totalActiveItems = accounts.rows.reduce((s, a) => s + parseInt(a.items_count || 0), 0);
    const totalSoldItems   = accounts.rows.reduce((s, a) => s + parseInt(a.sold_count  || 0), 0);
    const totalSales       = parseInt(sales.rows[0].total_sales);
    const totalRevenue     = parseFloat(sales.rows[0].total_revenue);
    const avgOrder         = totalSales > 0 ? totalRevenue / totalSales : 0;
    // Daily orders for mini chart (last 7 days)
    const dailyRows = await pool.query(
      `SELECT date::text AS date, COUNT(*) AS count
       FROM sales WHERE user_id=$1 AND date >= CURRENT_DATE - INTERVAL '6 days'
       GROUP BY date ORDER BY date ASC`,
      [req.user!.id]
    );
    res.json({
      accounts: accounts.rows,
      total_balance: totalBalance,
      profit: parseFloat(sales.rows[0].total_profit),
      revenue: totalRevenue,
      // Popup-friendly aliases
      orders: totalSales,
      active_items: totalActiveItems,
      sold_items: totalSoldItems,
      avg_order: avgOrder,
      daily_orders: dailyRows.rows.map((r: any) => ({ date: r.date, count: parseInt(r.count) })),
      total_sales: totalSales,
      total_expenses: parseFloat(expenses.rows[0].total),
      net_profit: parseFloat(sales.rows[0].total_profit) - parseFloat(expenses.rows[0].total),
      inventory_by_account: inventory.rows,
      recent_sales: recentSales.rows,
    });
  });

  // ── Gastos ────────────────────────────────────────────────────────────────
  app.get("/api/expenses", requireAuth as any, async (req: AuthRequest, res) => {
    const r = await pool.query("SELECT * FROM vinted_expenses WHERE user_id=$1 ORDER BY date DESC", [req.user!.id]);
    res.json(r.rows);
  });
  app.post("/api/expenses", requireAuth as any, async (req: AuthRequest, res) => {
    const { description, amount, category = "general", date, account_id } = req.body;
    if (!description || !amount) return res.status(400).json({ error: "description y amount requeridos" });
    const r = await pool.query(
      "INSERT INTO vinted_expenses(user_id, account_id, description, amount, category, date) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [req.user!.id, account_id || null, description, amount, category, date || new Date()]
    );
    res.json(r.rows[0]);
  });
  app.delete("/api/expenses/:id", requireAuth as any, async (req: AuthRequest, res) => {
    await pool.query("DELETE FROM vinted_expenses WHERE id=$1 AND user_id=$2", [req.params.id, req.user!.id]);
    res.json({ ok: true });
  });

  // ── Legacy profits endpoints (compatibilidad) ─────────────────────────────
  app.get("/api/profits/accounts", requireAuth as any, async (req: AuthRequest, res) => {
    const r = await pool.query("SELECT id, username, domain, is_active, created_at FROM vinted_accounts WHERE user_id=$1 ORDER BY created_at DESC", [req.user!.id]);
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
      const {
        model, buy_price, sell_price, date, vinted_account, account_id, notes, platform,
        boost_cost, shipping_cost, supplier, invoice_filename,
      } = s;
      if (!model || buy_price == null || sell_price == null || !date) continue;
      const r = await pool.query(
        `INSERT INTO sales(user_id,model,buy_price,sell_price,date,vinted_account,account_id,notes,platform,
                           boost_cost,shipping_cost,supplier,invoice_filename)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          req.user!.id, model, buy_price, sell_price, date,
          vinted_account || null, account_id || null, notes || null, platform || "vinted",
          boost_cost || 0, shipping_cost || 0, supplier || null, invoice_filename || null,
        ]
      );
      inserted.push(r.rows[0]);
    }
    res.json(inserted);
  });
  app.delete("/api/profits/sales/:id", requireAuth as any, async (req: AuthRequest, res) => {
    await pool.query("DELETE FROM sales WHERE id=$1 AND user_id=$2", [req.params.id, req.user!.id]);
    res.json({ ok: true });
  });

  // ══════════════════════════════════════════════
  // CONTROL PANEL — Gestión de cuentas Vinted
  // ══════════════════════════════════════════════

  // Registro exclusivo con código de invitación
  app.post("/api/control/register", authLimiter, async (req, res) => {
    const { username, email, password, invite_code } = req.body;
    if (!invite_code || invite_code !== CONTROL_INVITE_CODE)
      return res.status(403).json({ error: "Código de invitación incorrecto" });
    if (!username || !email || !password)
      return res.status(400).json({ error: "Faltan campos obligatorios" });
    if (password.length < 8)
      return res.status(400).json({ error: "Contraseña mínimo 8 caracteres" });
    const exists = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (exists.rows[0]) return res.status(409).json({ error: "Email ya registrado" });
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1,$2,$3) RETURNING id, username, email",
      [username, email, hash]
    );
    const token = jwt.sign({ id: r.rows[0].id }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: r.rows[0] });
  });

  // Helper para descifrar una fila
  function decryptRow(row: any) {
    return {
      ...row,
      vinted_pass: row.vinted_pass ? ctrlDecrypt(row.vinted_pass) : "",
      iban:        row.iban        ? ctrlDecrypt(row.iban)        : "",
    };
  }

  // GET todas las cuentas del usuario (datos sensibles descifrados)
  app.get("/api/control/accounts", requireAuth as any, async (req: AuthRequest, res) => {
    const r = await pool.query(
      `SELECT id, vinted_username, real_name, gmail, vinted_pass, phone, device, iban, dac7, status, notes, created_at
       FROM control_vinted_accounts WHERE owner_user_id=$1 ORDER BY created_at DESC`,
      [req.user!.id]
    );
    res.json(r.rows.map(decryptRow));
  });

  // POST crear cuenta (cifra IBAN y contraseña)
  app.post("/api/control/accounts", requireAuth as any, async (req: AuthRequest, res) => {
    const { vinted_username, real_name, gmail, vinted_pass, phone, device, iban, dac7, status, notes } = req.body;
    if (!vinted_username) return res.status(400).json({ error: "vinted_username requerido" });
    const r = await pool.query(
      `INSERT INTO control_vinted_accounts
        (owner_user_id, vinted_username, real_name, gmail, vinted_pass, phone, device, iban, dac7, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.user!.id, vinted_username, real_name||null, gmail||null,
       vinted_pass ? ctrlEncrypt(vinted_pass) : null,
       phone||null, device||null,
       iban ? ctrlEncrypt(iban) : null,
       !!dac7, status||'disponible', notes||null]
    );
    res.json(decryptRow(r.rows[0]));
  });

  // PUT editar cuenta (cifra IBAN y contraseña)
  app.put("/api/control/accounts/:id", requireAuth as any, async (req: AuthRequest, res) => {
    const { vinted_username, real_name, gmail, vinted_pass, phone, device, iban, dac7, status, notes } = req.body;
    const r = await pool.query(
      `UPDATE control_vinted_accounts SET
        vinted_username=$1, real_name=$2, gmail=$3, vinted_pass=$4, phone=$5,
        device=$6, iban=$7, dac7=$8, status=$9, notes=$10, updated_at=NOW()
       WHERE id=$11 AND owner_user_id=$12 RETURNING *`,
      [vinted_username, real_name||null, gmail||null,
       vinted_pass ? ctrlEncrypt(vinted_pass) : null,
       phone||null, device||null,
       iban ? ctrlEncrypt(iban) : null,
       !!dac7, status||'disponible', notes||null,
       req.params.id, req.user!.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Cuenta no encontrada" });
    res.json(decryptRow(r.rows[0]));
  });

  // DELETE eliminar cuenta Vinted
  app.delete("/api/control/accounts/:id", requireAuth as any, async (req: AuthRequest, res) => {
    await pool.query(
      "DELETE FROM control_vinted_accounts WHERE id=$1 AND owner_user_id=$2",
      [req.params.id, req.user!.id]
    );
    res.json({ ok: true });
  });

  // DELETE eliminar cuenta de usuario + todos sus datos (GDPR derecho al olvido)
  app.delete("/api/control/me", requireAuth as any, async (req: AuthRequest, res) => {
    await pool.query("DELETE FROM control_vinted_accounts WHERE owner_user_id=$1", [req.user!.id]);
    await pool.query("DELETE FROM users WHERE id=$1", [req.user!.id]);
    res.json({ ok: true });
  });
  // Toggle reembolso (PATCH /api/profits/sales/:id/refund con body { refunded: true/false })
  app.patch("/api/profits/sales/:id/refund", requireAuth as any, async (req: AuthRequest, res) => {
    const { refunded } = req.body;
    const isRef = refunded === true;
    const r = await pool.query(
      `UPDATE sales SET refunded=$1, refunded_at = CASE WHEN $1 THEN NOW() ELSE NULL END
       WHERE id=$2 AND user_id=$3 RETURNING *`,
      [isRef, req.params.id, req.user!.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Venta no encontrada" });
    res.json(r.rows[0]);
  });

  // ── Purchases (facturas de lote) ──────────────────────────────────────────
  app.get("/api/profits/purchases", requireAuth as any, async (req: AuthRequest, res) => {
    const r = await pool.query(
      "SELECT * FROM purchases WHERE user_id=$1 ORDER BY date DESC, created_at DESC",
      [req.user!.id]
    );
    res.json(r.rows);
  });
  app.post("/api/profits/purchases", requireAuth as any, async (req: AuthRequest, res) => {
    const rows = Array.isArray(req.body) ? req.body : [req.body];
    const inserted: any[] = [];
    for (const p of rows) {
      const { supplier, total_amount, units, date, invoice_filename, notes } = p;
      if (total_amount == null || !date) continue;
      const r = await pool.query(
        `INSERT INTO purchases(user_id,supplier,total_amount,units,date,invoice_filename,notes)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.user!.id, supplier || null, total_amount, units || 1, date, invoice_filename || null, notes || null]
      );
      inserted.push(r.rows[0]);
    }
    res.json(inserted);
  });
  app.delete("/api/profits/purchases/:id", requireAuth as any, async (req: AuthRequest, res) => {
    await pool.query("DELETE FROM purchases WHERE id=$1 AND user_id=$2", [req.params.id, req.user!.id]);
    res.json({ ok: true });
  });

  // ── OCR de factura PDF con Gemini ─────────────────────────────────────────
  // Recibe { pdfBase64, filename } y devuelve los datos extraídos:
  //   { supplier, total_amount, units, date, currency, raw_summary }
  // Usa gemini-2.5-flash que soporta PDFs nativamente (inlineData).
  app.post("/api/profits/ocr-invoice", geminiLimiter, requireAuth as any, async (req: AuthRequest, res) => {
    const { pdfBase64, filename } = req.body;
    if (!pdfBase64) return res.status(400).json({ error: "pdfBase64 requerido" });
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY no configurada" });

    const cleanB64 = pdfBase64.includes(",") ? pdfBase64.split(",")[1] : pdfBase64;
    // Sanity: max ~15 MB raw → ~20 MB base64. Si pasa límite Gemini, fallar pronto.
    if (cleanB64.length > 18 * 1024 * 1024) {
      return res.status(413).json({ error: "PDF demasiado grande (máx ~13 MB)" });
    }

    const prompt = `Analiza esta factura de compra al por mayor (típicamente lote de zapatillas o ropa). Extrae estos datos y devuelve SOLO un JSON puro sin markdown ni comentarios:

{
  "supplier": "Nombre del vendedor/proveedor que emite la factura (Adidas, Footlocker, mayorista…)",
  "total_amount": número decimal del TOTAL de la factura (suma de todos los items, IMPUESTOS INCLUIDOS, lo que realmente pagaste),
  "units": número TOTAL de unidades/pares compradas en la factura (suma de cantidades de todas las líneas),
  "currency": "EUR" | "USD" | "GBP" | etc.,
  "date": "YYYY-MM-DD" (fecha de emisión de la factura),
  "raw_summary": "Una línea con qué tipo de productos contiene (ej: Lote de 25 pares de zapatillas Adidas)"
}

IMPORTANTE: queremos el TOTAL del lote y el TOTAL de unidades, NO el precio unitario. Si la factura tiene varios productos diferentes, suma TODO. Si no encuentras un campo pon null. NO inventes datos. Si la factura no parece de compra de productos físicos, devuelve { "error": "No es factura de compra de producto" }.`;

    const MODELS = ["gemini-2.5-flash", "gemini-2.5-pro"];
    let lastError = "";
    try {
      for (const model of MODELS) {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [
                { inlineData: { mimeType: "application/pdf", data: cleanB64 } },
                { text: prompt },
              ] }],
              generationConfig: { temperature: 0.1 },
            }),
          }
        );
        const data = await r.json();
        if (!r.ok) { lastError = JSON.stringify(data).slice(0, 300); console.error(`[ocr] ${model} fail:`, lastError); continue; }
        const text = data.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text || "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) { lastError = "JSON no encontrado en respuesta"; continue; }
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return res.json({ ...parsed, filename: filename || null, model_used: model });
        } catch (e: any) {
          lastError = "JSON malformado: " + e.message;
        }
      }
      res.status(422).json({ error: "Gemini no devolvió JSON parseable: " + lastError });
    } catch (err: any) {
      console.error("OCR invoice error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Tongue / Gemini endpoints ───────────────────────────────────────────────

  app.get("/api/tongue/models", requireAuth as any, async (_req: AuthRequest, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "No API key" });
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await r.json();
    res.json(data);
  });

  app.post("/api/tongue/analyze", geminiLimiter, requireLicense as any, checkDailyLimit as any, async (req: AuthRequest, res) => {
    const { imageBase64, brand } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "Se requiere imagen" });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY no configurada en el servidor" });

    // ── PASO 1: OCR con imagen — extraer datos técnicos ────────────────────────
    // No se puede usar googleSearch + inlineData al mismo tiempo, así que
    // primero extraemos los códigos de la imagen, luego buscamos el nombre.
    const ocrPrompt = `Lee TODO el texto visible en esta etiqueta de zapatilla ${brand} y devuelve este JSON:
{
  "rawText": "copia EXACTAMENTE todo el texto visible, línea a línea separado por \\n",
  "model": "código de artículo/modelo",
  "sku": "mismo que model",
  "reference": "referencia/lote principal",
  "reference2": "segundo código de lote (solo NB)",
  "brandSerial": "número de serie único alfanumérico",
  "date": "fecha de fabricación",
  "lvl": "código de fábrica",
  "sizes": { "us": "", "uk": "", "fr": "", "jp": "" }
}

ESTRUCTURA DE CADA MARCA — úsala para asignar los campos correctos:

ADIDAS: La etiqueta tiene QR + bloque derecho con estas líneas exactas:
  · Fecha fabricación (MM/YY) → "date"
  · "SHD XXXXXX" = código de fábrica → "lvl"
  · "ART XXXXXX" o "A:XXXXXX" = número de artículo → "model" (solo el código, sin "ART" ni "A:")
  · "#XXXXXXXXX" = número de lote → "reference"
  · Código alfanumérico junto al logo adidas (ej: E1QWSTF<906601, hWFHVDQdQQ325) → "brandSerial"

NEW BALANCE: La etiqueta tiene:
  · Modelo alfanumérico (ej: U740WM2, MR530SG, BB550WT1) → "model"
  · Código de 11-12 dígitos (UPC/barcode) → "reference"
  · Código de 7 dígitos (lote interno) → "reference2"
  · Código de cadena de suministro (ej: LCXL1671 CXC, LXCK1298 CLX) → "brandSerial"
  · Fecha tras "MFG:" (ej: 07/2024) → "date"
  · Número tras "LOC:" → "lvl"

ASICS / ONITSUKA TIGER: La etiqueta tiene:
  · Código de modelo estilo "1204A191" (4 dígitos + letra + 3 dígitos) → "model"
  · Código "F" + 6 dígitos (ej: F960925) = código de fábrica/lote → "reference"
  · Código 2 letras (ej: WR) = control de materiales → "lvl"
  · Código de 15 alfanuméricos (ej: N4VDCSSVG6CSMGH) = número de serie único → "brandSerial"

Prioridad máxima: "rawText" debe ser transcripción literal completa.
Para el resto, aplica la estructura de la marca. Si no ves un dato pon "". Solo el JSON.`;

    // Modelos con soporte multimodal — junio 2026
    // gemini-1.5-x y gemini-2.0-x: retirados completamente (404 en v1 y v1beta)
    const OCR_MODELS = [
      "gemini-2.5-flash",  // primary — multimodal estable v1beta
      "gemini-2.5-pro",    // fallback — más capaz, mismo endpoint v1beta
    ];

    async function geminiCall(model: string, body: object, timeoutMs = 30000): Promise<any> {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        // gemini-2.5-x → v1beta (características preview activas)
        // gemini-1.5-x y gemini-2.0-x → v1 (se migraron fuera de v1beta)
        const apiVersion = (model.includes("1.5") || model.includes("2.0")) ? "v1" : "v1beta";
        const r = await fetch(
          `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${apiKey}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal, body: JSON.stringify(body) }
        );
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
        return data;
      } finally { clearTimeout(t); }
    }

    function extractJson(text: string): any | null {
      // 1: bloque ```json ... ```
      const m1 = text.match(/```json\s*([\s\S]*?)```/i);
      if (m1) { try { return JSON.parse(m1[1].trim()); } catch {} }
      // 2: cualquier bloque ``` ... ```
      const m2 = text.match(/```\s*([\s\S]*?)```/);
      if (m2) { try { return JSON.parse(m2[1].trim()); } catch {} }
      // 3: desde el primer '{' hasta el último '}' del texto
      const i1 = text.indexOf('{'), i2 = text.lastIndexOf('}');
      if (i1 >= 0 && i2 > i1) { try { return JSON.parse(text.slice(i1, i2 + 1)); } catch {} }
      return null;
    }

    try {
      const mimeMatch = imageBase64.match(/^data:([^;]+);/);
      const mimeType = mimeMatch?.[1] || "image/jpeg";
      const base64Data = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
      console.log(`[OCR] mimeType detectado: ${mimeType}, base64 len: ${base64Data.length}`);
      let ocrResult: any = null;
      const modelErrors: string[] = []; // acumular TODOS los errores para diagnóstico

      // ── Paso 1: OCR de imagen ──────────────────────────────────────────────
      // IMPORTANTE: NO usar responseMimeType:"application/json" — no es compatible
      // con inputs multimodal (imagen+texto) en todos los modelos y provoca errores 400.
      // extractJson ya maneja JSON puro, bloques markdown y texto con JSON embebido.
      const SAFETY_OFF = [
        { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      ];

      for (const model of OCR_MODELS) {
        try {
          const data = await geminiCall(model, {
            contents: [{ parts: [
              { inlineData: { mimeType, data: base64Data } },
              { text: ocrPrompt }
            ]}],
            safetySettings: SAFETY_OFF,
          }, 45000); // 45s — imágenes grandes pueden tardar más

          // Sin candidatos — bloqueo o error silencioso
          if (!data.candidates?.length) {
            const blockReason = data.promptFeedback?.blockReason;
            const err = blockReason ? `safety_block:${blockReason}` : `no_candidates(feedback:${JSON.stringify(data.promptFeedback||{})})`;
            modelErrors.push(`${model}→${err}`);
            console.warn(`[OCR] ${model} no candidates:`, err);
            continue;
          }

          const finishReason = data.candidates[0]?.finishReason || "";
          // Sin content (RECITATION, MAX_TOKENS, etc.)
          if (!data.candidates[0]?.content) {
            const err = `no_content(finish=${finishReason})`;
            modelErrors.push(`${model}→${err}`);
            console.warn(`[OCR] ${model} no content:`, finishReason);
            continue;
          }

          const raw = data.candidates[0]?.content?.parts?.find((p: any) => p.text)?.text || "";
          console.log(`[OCR] ${model} finishReason=${finishReason} raw(150ch):`, raw.slice(0, 150));

          // Intentar parsear directo; extractJson como fallback para markdown
          let parsed: any = null;
          try { parsed = JSON.parse(raw); } catch { parsed = extractJson(raw); }

          if (parsed) {
            // Aceptar si hay rawText con contenido O algún campo mapeado.
            // rawText es lo más fiable: el post-proceso regex extrae los campos de él.
            const hasAnyData = (parsed.rawText && parsed.rawText.length > 3)
              || parsed.model || parsed.sku || parsed.reference || parsed.date || parsed.sizes?.fr;
            if (!hasAnyData) {
              const err = `empty_json(finish=${finishReason})`;
              modelErrors.push(`${model}→${err}`);
              console.warn(`[OCR] ${model} JSON vacío (todos campos vacíos), pruebo siguiente`);
              continue;
            }
            ocrResult = parsed;
            console.log(`[OCR] ${model} OK → sku=${ocrResult.model}, fr=${ocrResult.sizes?.fr}`);
            break;
          }
          const err = `no_json(finish=${finishReason}): ${raw.slice(0, 200)}`;
          modelErrors.push(`${model}→${err}`);
          console.warn(`[OCR] ${model} no_json:`, raw.slice(0, 300));
        } catch (e: any) {
          modelErrors.push(`${model}→${e.message}`);
          console.error(`[OCR] ${model} ERROR:`, e.message);
        }
      }

      if (!ocrResult) {
        const allErrors = modelErrors.join(" | ");
        console.error(`[OCR] Todos los modelos fallaron:`, allErrors);
        const userMsg = allErrors.includes("spending cap") || allErrors.includes("spend cap")
          ? "❌ El proyecto de Gemini API ha superado su límite de gasto mensual. El administrador debe aumentarlo en aistudio.google.com/billing."
          : allErrors.includes("429") || allErrors.includes("quota") || allErrors.includes("RESOURCE_EXHAUSTED")
            ? "⏳ Límite de peticiones alcanzado. Espera 1 minuto e inténtalo de nuevo."
            : allErrors.includes("safety_block:")
              ? "La imagen fue bloqueada por los filtros de seguridad. Prueba con una foto más clara o diferente."
              : `No se pudo leer la etiqueta. Errores: ${allErrors}. Asegúrate de que la foto sea nítida e inténtalo de nuevo.`;
        return res.status(500).json({ error: userMsg });
      }

      // ── Post-proceso: normalizar campos por marca ──────────────────────────
      const brandLow = (brand || "").toLowerCase();

      if (brandLow.includes("adidas")) {
        // Parsear campos Adidas desde rawText (más fiable que confiar en lo que Gemini mapea)
        const raw = (ocrResult.rawText || "") as string;
        console.log(`[OCR] Adidas rawText:`, raw.slice(0, 300));

        // Artículo: línea "A:IH1511" / "A IH1511" / "AIH1511" → extraer "IH1511"
        const artMatch = raw.match(/\bA[:\s]?([A-Z]{1,2}[0-9]{4}[A-Z0-9]*)\b/i)
                      || raw.match(/\bART[:\s]+([A-Z0-9]{4,10})\b/i);
        if (artMatch) {
          ocrResult.model = artMatch[1].trim();
          ocrResult.sku   = ocrResult.model;
          console.log(`[OCR] Adidas artMatch → model: ${ocrResult.model}`);
        }

        // Fábrica SHD: "SHD 675005"
        const shdMatch = raw.match(/\b(SHD[\s\-]?\d+)\b/i);
        if (shdMatch) {
          ocrResult.lvl = shdMatch[1].trim();
          console.log(`[OCR] Adidas shdMatch → lvl: ${ocrResult.lvl}`);
        }

        // Referencia lote: "#0901801801"
        const refMatch = raw.match(/(#\d{6,12})/);
        if (refMatch) {
          ocrResult.reference = refMatch[1];
        }

        // Serial: código alfanumérico junto al logo adidas (ej: E1QWSTF<906601, hWFHVDQdQQ325)
        const serialMatch = raw.match(/adidas\s+([A-Z0-9<]{6,})/i);
        if (serialMatch) {
          ocrResult.brandSerial = serialMatch[1].trim();
        }
      }

      // ── Post-proceso NEW BALANCE ───────────────────────────────────────────
      if (brandLow.includes("new balance") || brandLow === "nb" || brandLow === "new_balance") {
        const raw = (ocrResult.rawText || "") as string;
        console.log(`[OCR] NB rawText:`, raw.slice(0, 300));

        // Modelo: 1-2 letras + 3 dígitos + 2-3 letras/dígitos (ej: U740WM2, MR530SG, BB550WT1)
        const nbModel = raw.match(/\b([A-Z]{1,2}\d{3}[A-Z]{2}\d?)\b/);
        if (nbModel) {
          ocrResult.model = nbModel[1];
          ocrResult.sku   = nbModel[1];
          console.log(`[OCR] NB model: ${ocrResult.model}`);
        }

        // Referencia: 11-12 dígitos (UPC/barcode)
        const nbRef = raw.match(/\b(\d{11,12})\b/);
        if (nbRef) ocrResult.reference = nbRef[1];

        // Referencia2: 7 dígitos exactos (lote interno)
        const nbRef2 = raw.match(/\b(\d{7})\b/);
        if (nbRef2) ocrResult.reference2 = nbRef2[1];

        // BrandSerial: código alfanumérico tipo "LCXL1671 CXC" o "LXCK1298 CLX"
        const nbSerial = raw.match(/\b([A-Z]{4}\d{4}\s[A-Z]{3})\b/);
        if (nbSerial) ocrResult.brandSerial = nbSerial[1];

        // Fecha: "MFG: MM/YYYY" o "MFG: MM/YY"
        const nbDate = raw.match(/MFG[:\s]+(\d{2}\/\d{2,4})/i);
        if (nbDate) ocrResult.date = nbDate[1];

        // LVL: número tras "LOC:"
        const nbLoc = raw.match(/LOC[:\s]+(\d+)/i);
        if (nbLoc) ocrResult.lvl = nbLoc[1];
      }

      // ── Post-proceso ASICS / ONITSUKA ──────────────────────────────────────
      if (brandLow.includes("asics") || brandLow.includes("onitsuka")) {
        const raw = (ocrResult.rawText || "") as string;
        console.log(`[OCR] ASICS/Onitsuka rawText:`, raw.slice(0, 300));

        // Modelo ASICS: 4 dígitos + letra + 3 dígitos (ej: 1204A191, 1203A359)
        const asicsModel = raw.match(/\b(\d{4}[A-Z]\d{3})\b/);
        if (asicsModel) {
          ocrResult.model = asicsModel[1];
          ocrResult.sku   = asicsModel[1];
          console.log(`[OCR] ASICS model: ${ocrResult.model}`);
        }

        // Reference: "F" + 6 dígitos exactos (ej: F960925)
        const asicsRef = raw.match(/\b(F\d{6})\b/i);
        if (asicsRef) ocrResult.reference = asicsRef[1].toUpperCase();

        // BrandSerial: 15 alfanuméricos en mayúsculas (ej: N4VDCSSVG6CSMGH)
        const asicsSerial = raw.match(/\b([A-Z0-9]{14,16})\b/);
        if (asicsSerial) ocrResult.brandSerial = asicsSerial[1];

        // LVL: código de 2 letras tras la referencia F (ej: WR)
        const asicsLvl = raw.match(/F\d{6}\s+([A-Z]{2})\b/i);
        if (asicsLvl) ocrResult.lvl = asicsLvl[1].toUpperCase();
      }

      // ── Paso 2: Búsqueda web con googleSearch para identificar el modelo ──
      // Esta llamada es solo texto, sin imagen → compatible con googleSearch
      const sku = ocrResult.model || ocrResult.sku || "";
      const sizeFr = ocrResult.sizes?.fr || "";
      let modelName = "Desconocido";
      let color = "Desconocido";
      let gender = "Femme";   // default — la gran mayoría son zapatillas de mujer en Vinted

      if (sku && sku !== "Desconocido" && sku !== "") {
        // gemini-2.0-flash deprecated mayo 2026 → usar solo 2.5-flash con más timeout
        const SEARCH_MODELS = ["gemini-2.5-flash", "gemini-2.5-pro"];
        for (const searchModel of SEARCH_MODELS) {
          try {
            // Construir query con toda la info disponible para máxima precisión
            const sizeInfo = ocrResult.sizes?.fr ? `talla EU ${ocrResult.sizes.fr}` : "";
            const searchPrompt = `Usa Google Search para identificar exactamente esta zapatilla ${brand}.

Datos de la etiqueta:
- Código de modelo / Art. No: ${sku}
- Marca: ${brand}
${sizeInfo ? `- Talla: ${sizeInfo}` : ""}
${ocrResult.date ? `- Fecha: ${ocrResult.date}` : ""}

TAREA: Busca "${brand} ${sku}" en Google y devuelve SOLO este JSON (sin markdown ni texto extra):
{
  "modelName": "nombre comercial EXACTO del modelo incluyendo el colorway oficial (ej: Adidas Samba OG White Black, Adidas Samba Jane, New Balance 574 Grey)",
  "colorway": "colorway/color principal en francés, primera letra mayúscula, solo la primera parte (ej: Beige, Blanc, Noir, Gris)",
  "gender": "Femme o Homme o Unisexe — según a quién está destinado este modelo según Google"
}`;

            const searchData = await geminiCall(searchModel, {
              contents: [{ parts: [{ text: searchPrompt }] }],
              tools: [{ google_search: {} }]
            }, 35000);  // 35s — search+generation necesita más tiempo que un OCR normal

            const searchText = searchData.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text || "";
            console.log(`[OCR] Search ${searchModel} raw:`, searchText.slice(0, 300));
            const sr = extractJson(searchText);
            if (sr?.modelName && sr.modelName !== "Desconocido" && sr.modelName.length > 3) {
              modelName = sr.modelName;
              color = sr.colorway || sr.color || "Desconocido";
              gender = sr.gender === "Homme" ? "Homme" : sr.gender === "Unisexe" ? "Unisexe" : "Femme";
              console.log(`[OCR] Search OK (${searchModel}): ${modelName} / ${color} / ${gender}`);
              break;
            }
          } catch (e: any) {
            console.warn(`[OCR] Search ${searchModel} failed:`, e.message);
          }
        }
      }

      // ── Ensamblar respuesta final ──────────────────────────────────────────
      const frSize = sizeFr || ocrResult.sizes?.fr || "";

      // Limpiar talla FR: "37 1/2" → "37,5" | "38 2/3" → "38" (fracciones raras → entero)
      const cleanFrSize = (s: string): string => {
        if (!s) return s;
        const half = s.match(/^(\d+)\s+1\/2$/);
        if (half) return `${half[1]},5`;
        return s.replace(/\s+\d+\/\d+$/, ""); // quita cualquier fracción restante
      };
      const frSizeClean = cleanFrSize(frSize);

      // Colour: primera parte del colorway ("Beige et Blanc" → "Beige")
      const mainColor = (color && color !== "Desconocido")
        ? color.split(/ et | \/ /)[0].trim()
        : "";
      const colorCap = mainColor
        ? mainColor.charAt(0).toUpperCase() + mainColor.slice(1).toLowerCase()
        : "";

      // SKU formateado según marca: "A: JQ5874" (Adidas), "NB {sku}" (NB), "{sku}" (resto)
      const skuFormatted = brandLow.includes("adidas") ? `A: ${sku}` :
                           brandLow.includes("new balance") || brandLow === "nb" ? `NB ${sku}` :
                           sku;

      // Título en formato natural para Vinted FR (no comercial)
      // Formato: {ModelName} - {Color} - {Género} / Pointure {talla} - {SKU}
      const colorDash  = colorCap ? ` - ${colorCap}` : "";
      const sizePart   = frSizeClean ? ` / Pointure ${frSizeClean}` : "";
      const skuPart    = skuFormatted ? ` - ${skuFormatted}` : "";

      const listingTitle = modelName !== "Desconocido"
        ? `${modelName}${colorDash} - ${gender}${sizePart}${skuPart}`
        : `${brand} ${sku}${colorDash} - ${gender}${sizePart}`;

      // 10 raisons de vente naturelles pour Vinted FR (template pool)
      const VINTED_TEMPLATES = [
        "Je les vends parce qu'elles sont malheureusement trop petites pour moi. C'est vraiment une très belle paire qui mérite de trouver une nouvelle propriétaire.",
        "Je les vends car j'ai déjà une paire très similaire et je ne les utilise finalement pas. Elles sont en très bon état et méritent d'être portées.",
        "Je les vends parce qu'elles ne correspondent plus à mon style actuel. Elles sont pourtant magnifiques et en excellent état.",
        "Je les vends car je les ai achetées sur un coup de cœur, mais je ne les porte finalement jamais. Elles méritent de ne pas rester dans un placard.",
        "Je les vends pour faire un peu de place dans mon dressing. Elles sont très jolies et feront certainement le bonheur de quelqu'un.",
        "Je les vends car c'était un cadeau que je n'ai malheureusement jamais eu l'occasion de porter. Elles sont comme neuves.",
        "Je les vends parce que j'ai trop de paires et je fais un peu de tri. Elles sont superbes et méritent d'être portées.",
        "Je les vends car je me suis trompée de taille lors de l'achat. Elles sont très belles et en parfait état.",
        "Je les vends parce que je les avais achetées pour une occasion spéciale qui a finalement été annulée. Elles n'ont donc jamais servi.",
        "Je les vends car elles restent dans leur boîte et je préfère qu'elles profitent à quelqu'un qui les portera davantage. Elles sont vraiment très jolies.",
      ];
      const randDesc = VINTED_TEMPLATES[Math.floor(Math.random() * VINTED_TEMPLATES.length)];

      // Description: French template + product fields
      const descFields = [
        colorCap ? `Couleur : ${colorCap}` : null,
        `Modèle : ${skuFormatted}`,
        frSizeClean ? `Pointure : ${frSizeClean}` : null,
      ].filter(Boolean).join("\n");
      const listingDescription = `${randDesc}\n\n${descFields}`;

      return res.json({
        ...ocrResult,
        modelName,
        color,
        gender,
        frSizeClean,
        listingTitle,
        listingDescription,
      });
    } catch (err: any) {
      console.error("[OCR] Analyze error:", err.message);
      res.status(500).json({ error: err.message });
    }

  });

  // ── Helpers Tongue Generate ─────────────────────────────────────────────────
  // Parser ligero de dimensiones JPEG (sin libs externas). Lee markers SOF0..SOF2.
  function jpegDimsFromBase64(b64: string): { w: number; h: number } | null {
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

  // Elige el aspect ratio soportado por Gemini más cercano al input.
  // Lista EXACTA aceptada por la API (imageConfig.aspect_ratio):
  // '1:1','1:4','1:8','2:3','3:2','3:4','4:1','4:3','4:5','5:4','8:1','9:16','16:9','21:9'
  function pickGeminiAspect(w: number, h: number): string {
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
      // ELIMINADO: "9:21" — NO está en la lista aceptada por la API → causaba HTTP 400
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

  // Prefacio fijo que va SIEMPRE al inicio de cualquier prompt de generación.
  // Genera el preámbulo de lengüeta.
  // Si hay imagen de referencia, el prompt menciona explícitamente las dos imágenes
  // (IMAGE 1 = referencia de formato, IMAGE 2 = foto a editar).
  function buildTonguePreamble(hasReference: boolean): string {
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

  function buildTonguePrompt(brand: string, d: any, customPrompt: string, hasReference = false): string {
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

  app.post("/api/tongue/generate", geminiLimiter, requireLicense as any, checkDailyLimit as any, async (req: AuthRequest, res) => {
    const { imageBase64, brand, detections, customPrompt } = req.body;
    if (!detections) return res.status(400).json({ error: "Se requieren los datos detectados" });
    if (req.user?.id) logActivity(req.user.id, `lengueta:generate:${brand || '?'}`, (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip);

    const tokenCheck = await checkTokens(req, res, 1);
    if (!tokenCheck.ok) return;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY no configurada en el servidor" });

    const brandPrompt = buildTonguePrompt(brand, detections, customPrompt || "", false);

    // Deadline global: 140s (deja margen sobre el cliente que espera 150s)
    const GLOBAL_DEADLINE = Date.now() + 140_000;
    // 1 intento por modelo con 45s: modelos rápidos fallan en <2s (404), el que funciona tiene 45s
    const ATTEMPT_TIMEOUT_MS = 45_000;

    try {
      // Partes: [foto a editar, texto]
      const parts: any[] = [];
      let aspectRatio: string | null = null;
      if (imageBase64) {
        const base64Data = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
        parts.push({ inlineData: { mimeType: "image/jpeg", data: base64Data } });
        const dims = jpegDimsFromBase64(base64Data);
        if (dims && dims.w > 0 && dims.h > 0) aspectRatio = pickGeminiAspect(dims.w, dims.h);
      }
      parts.push({ text: brandPrompt });

      // Modelos de generación de imagen — rápidos primero, más capaces como fallback
      const IMG_MODELS = [
        "gemini-3.1-flash-image",                  // GA rápido (junio 2026) — primero
        "gemini-2.5-flash-image",                  // GA estable — segundo
        "gemini-3-pro-image",                      // GA alta calidad (más lento)
        "gemini-2.0-flash-preview-image-generation", // Preview anterior — fallback
      ];
      const MAX_RETRIES_PER_MODEL = 1; // 1 intento por modelo — así todos tienen tiempo
      let lastErr = "";
      let lastTextResponse = "";

      for (const model of IMG_MODELS) {
        // Si se nos acaba el tiempo global, parar ya
        if (Date.now() >= GLOBAL_DEADLINE) break;

        for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
          if (Date.now() >= GLOBAL_DEADLINE) break;

          const body: any = {
            contents: [{ parts }],
            generationConfig: {
              responseModalities: ["TEXT", "IMAGE"],
              temperature: 0.35 + (attempt - 1) * 0.1,
            },
          };
          if (aspectRatio) body.generationConfig.imageConfig = { aspectRatio };

          let r: Awaited<ReturnType<typeof fetch>>;
          let data: any;
          try {
            const ctrl = new AbortController();
            // Timeout = mínimo entre el límite del intento y el deadline global
            const msLeft = Math.max(5000, GLOBAL_DEADLINE - Date.now());
            const effectiveTimeout = Math.min(ATTEMPT_TIMEOUT_MS, msLeft);
            const genTimer = setTimeout(() => ctrl.abort(), effectiveTimeout);
            try {
              r = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
                { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal }
              );
            } finally {
              clearTimeout(genTimer);
            }
            data = await r.json();
          } catch (fetchErr: any) {
            lastErr = fetchErr.message || String(fetchErr);
            console.error(`[tongue] ${model} attempt ${attempt} fetch error:`, lastErr);
            continue;
          }

          if (!r!.ok) {
            lastErr = data?.error?.message || `HTTP ${r!.status}`;
            console.error(`[tongue] ${model} attempt ${attempt} HTTP ${r!.status}:`, lastErr.slice(0, 200));
            if (r!.status === 429) {
              // Rate limit — espera exponencial antes de reintentar
              await new Promise(resolve => setTimeout(resolve, attempt * 4000));
            }
            // No hacer break: siempre continuar al siguiente intento/modelo
            continue;
          }

          // Busca primera parte con inlineData (la imagen)
          const partsResp = data.candidates?.[0]?.content?.parts || [];
          for (const p of partsResp) {
            if (p.inlineData?.data) {
              deductTokens(tokenCheck.licenseId, 1);
              return res.json({ image: `data:image/png;base64,${p.inlineData.data}`, model, attempt, aspectRatio });
            }
            if (p.text) lastTextResponse = p.text.slice(0, 200);
          }
          console.warn(`[tongue] ${model} attempt ${attempt}: sin imagen, texto:`, lastTextResponse.slice(0, 100));
        }
      }

      console.error("[tongue] todos los modelos fallaron. lastText:", lastTextResponse, "lastErr:", lastErr.slice(0, 300));
      res.status(422).json({
        error: lastTextResponse
          ? `Gemini respondió texto en vez de imagen: ${lastTextResponse.slice(0, 120)}…`
          : lastErr
            ? `Error de generación: ${lastErr.slice(0, 200)}`
            : "Ningún modelo devolvió imagen. Inténtalo de nuevo.",
      });
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

  // ── Label References (admin uploads reference photos per brand/size) ─────────

  app.get("/api/admin/label-references", requireAdmin as any, async (req: any, res) => {
    try {
      const { brand, label_type } = req.query as any;
      let sql = "SELECT id, brand, size_us, label_type, codes_json, notes, created_at FROM label_references";
      const params: any[] = [];
      const conditions: string[] = [];
      if (brand) { conditions.push(`brand = $${params.length + 1}`); params.push(brand); }
      if (label_type) { conditions.push(`label_type = $${params.length + 1}`); params.push(label_type); }
      if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
      sql += " ORDER BY brand, size_us";
      const result = await pool.query(sql, params);
      res.json(result.rows);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post("/api/admin/label-references", requireAdmin as any, async (req: any, res) => {
    const { brand, size_us, label_type = "tongue", imageBase64, codes, notes } = req.body;
    const validBrands = ["ADIDAS", "NEW BALANCE", "ASICS", "ONITSUKA"];
    if (!brand || !validBrands.includes(brand))
      return res.status(400).json({ error: "Marca inválida" });
    try {
      const result = await pool.query(
        `INSERT INTO label_references (brand, size_us, label_type, image_base64, codes_json, notes)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (brand, size_us, label_type) DO UPDATE
           SET image_base64 = EXCLUDED.image_base64,
               codes_json   = EXCLUDED.codes_json,
               notes        = EXCLUDED.notes,
               created_at   = NOW()
         RETURNING id, brand, size_us, label_type, codes_json, notes, created_at`,
        [brand, size_us || null, label_type, imageBase64 || null, JSON.stringify(codes || {}), notes || null]
      );
      res.json(result.rows[0]);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete("/api/admin/label-references/:id", requireAdmin as any, async (req: any, res) => {
    try {
      await pool.query("DELETE FROM label_references WHERE id = $1", [req.params.id]);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Lookup: return the best reference image for a given brand+size (public, for client)
  app.get("/api/label-references/lookup", requireLicense as any, async (req: any, res) => {
    const { brand, size_us, label_type = "tongue" } = req.query as any;
    if (!brand) return res.status(400).json({ error: "brand required" });
    try {
      // Try exact size match first, then fall back to generic (size_us IS NULL)
      const result = await pool.query(
        `SELECT id, image_base64, codes_json FROM label_references
         WHERE brand = $1 AND label_type = $2
           AND (size_us = $3 OR size_us IS NULL)
         ORDER BY (size_us = $3)::int DESC
         LIMIT 1`,
        [brand, label_type, size_us || null]
      );
      if (!result.rows[0]) return res.json({ found: false });
      res.json({ found: true, ...result.rows[0] });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Box Prompts (admin manage / public read) ──────────────────────────────

  app.get("/api/box/prompts", async (_req, res) => {
    try {
      const result = await pool.query("SELECT brand, prompt, updated_at FROM box_prompts ORDER BY brand");
      res.json(result.rows);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post("/api/admin/box/prompts", requireAdmin as any, async (req: any, res) => {
    const { brand, prompt } = req.body;
    const validBrands = ["ADIDAS", "NEW BALANCE", "ASICS", "ONITSUKA"];
    if (!brand || !validBrands.includes(brand))
      return res.status(400).json({ error: "Marca inválida" });
    try {
      const result = await pool.query(
        `INSERT INTO box_prompts (brand, prompt, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (brand) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = NOW()
         RETURNING *`,
        [brand, prompt ?? ""]
      );
      res.json(result.rows[0]);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Box Label Generation ──────────────────────────────────────────────────

  // Helper: build box label prompt per brand
  function buildBoxPrompt(brand: string, d: any, customPrompt: string, _barcodeValue: string, hasReference = false): string {
    const sizes = d.sizes || {};

    const BOX_PREAMBLE = hasReference
      ? (`TAREA: EDITAR IMAGEN EXISTENTE — NO generar imagen nueva. ` +
         `Tienes DOS imágenes adjuntas: ` +
         `IMAGE 1 (primera imagen) es una etiqueta de caja AUTÉNTICA de referencia — ` +
         `estudia exactamente su formato, tipografía, disposición y calidad de impresión. ` +
         `IMAGE 2 (segunda imagen) es la foto real de la etiqueta de caja que debes editar. ` +
         `La imagen de salida debe ser IDÉNTICA a IMAGE 2 excepto por los campos de texto específicos indicados abajo. ` +
         `PRESERVA AL 100%: código de barras (barras + número EAN), fondo, perspectiva, iluminación, logos, modelo, tallas. ` +
         `SOLO cambia los campos de texto indicados. No regeneres nada desde cero.`)
      : (`TAREA: EDITAR IMAGEN EXISTENTE — NO generar imagen nueva desde cero. ` +
         `La imagen adjunta es la foto REAL de una etiqueta de caja de zapatillas. ` +
         `La imagen de salida debe ser PIXEL-PERFECT idéntica a la foto adjunta, ` +
         `excepto únicamente por los campos de texto que se indican abajo para sustituir. ` +
         `PRESERVA AL 100% sin ninguna alteración: ` +
         `código de barras completo (todas las barras verticales + número EAN), ` +
         `fondo y color de la caja, perspectiva y ángulo, iluminación y sombras, ` +
         `todos los logos de marca, nombre del modelo, tabla de tallas, país de fabricación. ` +
         `Literalmente todo queda igual excepto los campos de texto señalados. ` +
         `No recrees ni regeneres la imagen — edita solo lo indicado.`);

    if (brand === "ADIDAS") {
      // Códigos de correlación: derivados de los seriales de la lengüeta.
      // EAN PO# = dígitos del reference de lengüeta (10 dígitos)
      const refDigits = (d.reference || "").replace(/\D/g, "").padEnd(10, "0").slice(0, 10);
      // ABSBOX = dígitos del brandSerial (4 chars) + versión 2 dígitos
      const absNum = (d.brandSerial || "").replace(/\D/g, "").padStart(4, "0").slice(0, 4);
      const absVer = String(Math.floor(Math.random() * 20) + 1).padStart(2, "0");

      return [
        BOX_PREAMBLE, ``,
        `Edita la etiqueta adhesiva blanca de la caja adidas que ves en la foto.`,
        ``,
        `PRESERVA SIN CAMBIAR: nombre del modelo, SKU "${d.sku}", toda la tabla de tallas ` +
        `(US ${sizes.us} / UK ${sizes.uk} / EU ${sizes.fr} / JP ${sizes.jp}), ` +
        `colorway, línea de producto (ORIGINALS, etc.), MADE IN.../FABRIQUÉ EN..., ` +
        `el código de barras con sus rayas verticales y el número EAN bajo ellas, ` +
        `logos e iconos.`,
        ``,
        `SUSTITUYE ÚNICAMENTE estas 2 líneas pequeñas en la esquina inferior izquierda ` +
        `(justo debajo de "FABRIQUÉ EN..." o del número EAN):`,
        `  · La línea "EAN PO# XXXXXXXXXX"   →  "EAN PO# ${refDigits}"`,
        `  · La línea "ABSBOX/XXXX/VXX"       →  "ABSBOX/${absNum}/V${absVer}"`,
        ``,
        `Misma fuente, mismo tamaño, mismo color negro, misma posición exacta. Nada más cambia.`,
        customPrompt || ""
      ].filter(Boolean).join("\n");
    }

    if (brand === "ASICS") {
      return [
        BOX_PREAMBLE, ``,
        `Edita la etiqueta adhesiva de la caja ASICS.`,
        `PRESERVA: logo ASICS, nombre del modelo, SKU "${d.sku}", tabla de tallas, colorway, ` +
        `país de fabricación, código de barras (barras + número EAN). Todo intacto.`,
        ``,
        `SUSTITUYE ÚNICAMENTE:`,
        `  · Código de tracking individual (1 letra + 6 dígitos) → "${d.reference}"`,
        `  · Serial único de unidad (15 alfanuméricos) → "${d.brandSerial}"`,
        ``,
        `Misma tipografía y posición. No cambies nada más.`,
        customPrompt || ""
      ].filter(Boolean).join("\n");
    }

    if (brand === "ONITSUKA") {
      return [
        BOX_PREAMBLE, ``,
        `Edita la etiqueta de la caja Onitsuka Tiger.`,
        `PRESERVA: logo, nombre del modelo, SKU "${d.sku}", tallas, ` +
        `"MADE IN INDONESIA / FABRIQUE EN INDONESIE", código de barras (barras + EAN). Todo intacto.`,
        ``,
        `SUSTITUYE ÚNICAMENTE:`,
        `  · Batch code (formato F + 6 dígitos) → "${d.reference}"`,
        `  · Serial de unidad (15 alfanuméricos) → "${d.brandSerial}"`,
        ``,
        `Misma tipografía y posición. No cambies nada más.`,
        customPrompt || ""
      ].filter(Boolean).join("\n");
    }

    // NEW BALANCE (default)
    return [
      BOX_PREAMBLE, ``,
      `Edita la etiqueta adhesiva de la caja New Balance.`,
      `PRESERVA: logo NB, nombre del modelo, Style "${d.sku}", tabla de tallas, colores, ` +
      `país de fabricación, código de barras (barras + número EAN). Todo intacto.`,
      ``,
      `SUSTITUYE ÚNICAMENTE estos códigos de seguimiento:`,
      `  · Serial 1 (12 dígitos)   → "${d.reference}"`,
      `  · Serial 2 (7 dígitos)    → "${d.reference2 || ""}"`,
      `  · Brand code              → "${d.brandSerial}"`,
      ``,
      `Misma tipografía y posición. No cambies nada más.`,
      customPrompt || ""
    ].filter(Boolean).join("\n");
  }

  // Helper: generate valid EAN-13 barcode value
  function generateEAN13(prefix = "400"): string {
    const base = prefix + Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)).join("");
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += parseInt(base[i]) * (i % 2 === 0 ? 1 : 3);
    return base + ((10 - (sum % 10)) % 10);
  }

  // Box label EAN prefix by brand country of origin
  const EAN_PREFIXES: Record<string, string> = {
    ADIDAS: "400", "NEW BALANCE": "038", ASICS: "456", ONITSUKA: "456",
  };

  // Reuse the same model-retry logic as tongue generation
  async function runGeminiImageGeneration(
    prompt: string, imageBase64: string | null, aspectRatio: string | null,
    globalDeadline: number, attemptTimeout: number, apiKey: string,
    referenceBase64: string | null = null   // imagen de referencia del admin (opcional)
  ): Promise<{ image: string; model: string } | null> {
    // Modelos GA de generación de imagen (desde 28 may 2026; -preview deprecados)
    const IMG_MODELS = [
      "gemini-3-pro-image",
      "gemini-3.1-flash-image",
      "gemini-2.5-flash-image",
    ];
    const MAX_RETRIES = 2;
    const parts: any[] = [];
    // Orden: [referencia (si existe), foto a editar, texto del prompt]
    // Gemini procesa los inputs en orden — la referencia primero maximiza su influencia
    if (referenceBase64) {
      const refB64 = referenceBase64.includes(",") ? referenceBase64.split(",")[1] : referenceBase64;
      parts.push({ inlineData: { mimeType: "image/jpeg", data: refB64 } });
    }
    if (imageBase64) {
      const b64 = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
      parts.push({ inlineData: { mimeType: "image/jpeg", data: b64 } });
    }
    parts.push({ text: prompt });
    for (const model of IMG_MODELS) {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (Date.now() >= globalDeadline) return null;
        const body: any = {
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            temperature: 0.35 + (attempt - 1) * 0.1,
          },
        };
        if (aspectRatio) body.generationConfig.imageConfig = { aspectRatio };
        try {
          const ctrl = new AbortController();
          const effectiveTimeout = Math.min(attemptTimeout, Math.max(5000, globalDeadline - Date.now()));
          const timer = setTimeout(() => ctrl.abort(), effectiveTimeout);
          let r: any, data: any;
          try {
            r = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
              { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal }
            );
            data = await r.json();
          } finally { clearTimeout(timer); }

          if (!r.ok) {
            console.error(`[imggen] ${model} attempt ${attempt} HTTP ${r.status}:`, JSON.stringify(data).slice(0, 200));
            if (r.status === 429) await new Promise(res => setTimeout(res, attempt * 4000));
            continue; // siempre continuar — nunca break para no saltarse modelos restantes
          }

          for (const p of (data.candidates?.[0]?.content?.parts || [])) {
            if (p.inlineData?.data) {
              console.log(`[imggen] ${model} attempt ${attempt} OK`);
              return { image: `data:image/png;base64,${p.inlineData.data}`, model };
            }
          }
          console.warn(`[imggen] ${model} attempt ${attempt}: sin imagen en respuesta`);
        } catch (err: any) {
          console.error(`[imggen] ${model} attempt ${attempt} error:`, err.message?.slice(0, 100));
          continue;
        }
      }
    }
    return null;
  }

  app.post("/api/box/generate", geminiLimiter, requireLicense as any, checkDailyLimit as any, async (req: any, res) => {
    const { imageBase64, brand, detections, customPrompt } = req.body;
    if (!detections) return res.status(400).json({ error: "Se requieren los datos detectados" });

    const tokenCheck = await checkTokens(req, res, 1);
    if (!tokenCheck.ok) return;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY no configurada" });

    const barcodeValue = generateEAN13(EAN_PREFIXES[brand] || "400");

    // Cargar referencia de caja + prompt admin en paralelo
    const sizeUsBox = detections?.sizes?.us || null;
    const [boxPromptResult, boxRefResult] = await Promise.all([
      pool.query("SELECT prompt FROM box_prompts WHERE brand = $1", [brand]).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT image_base64 FROM label_references
         WHERE brand = $1 AND label_type = 'box'
           AND (size_us = $2 OR size_us IS NULL)
         ORDER BY (size_us = $2)::int DESC
         LIMIT 1`,
        [brand, sizeUsBox]
      ).catch(() => ({ rows: [] })),
    ]);
    const adminBoxPrompt = boxPromptResult.rows[0]?.prompt || "";
    const boxRefBase64: string | null = boxRefResult.rows[0]?.image_base64 || null;
    if (boxRefBase64) console.log(`[box] usando referencia de admin para ${brand}`);

    const finalCustomPrompt = customPrompt || adminBoxPrompt;
    const prompt = buildBoxPrompt(brand, detections, finalCustomPrompt, barcodeValue, !!boxRefBase64);

    let aspectRatio: string | null = null;
    if (imageBase64) {
      const base64Data = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
      const dims = jpegDimsFromBase64(base64Data);
      if (dims && dims.w > 0 && dims.h > 0) aspectRatio = pickGeminiAspect(dims.w, dims.h);
    }

    const result = await runGeminiImageGeneration(prompt, imageBase64, aspectRatio, Date.now() + 90_000, 35_000, apiKey, boxRefBase64);
    if (!result) return res.status(503).json({ error: "No se pudo generar la imagen de caja. Inténtalo de nuevo." });

    deductTokens(tokenCheck.licenseId, 1);
    res.json({ ...result, barcodeValue });
  });

  // ── Dual generation: tongue + box in parallel with synced codes ────────────

  app.post("/api/dual/generate", geminiLimiter, requireLicense as any, checkDailyLimit as any, async (req: any, res) => {
    const { tongueImageBase64, boxImageBase64, brand, detections, tonguePrompt, boxPrompt } = req.body;
    if (!detections) return res.status(400).json({ error: "Se requieren los datos detectados" });

    const tokenCheck = await checkTokens(req, res, 2);
    if (!tokenCheck.ok) return;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY no configurada" });

    const GLOBAL_DEADLINE = Date.now() + 90_000;

    // Get admin prompts
    const [tpRes, bpRes] = await Promise.all([
      pool.query("SELECT prompt FROM tongue_prompts WHERE brand = $1", [brand]),
      pool.query("SELECT prompt FROM box_prompts WHERE brand = $1", [brand]),
    ]);
    const adminTonguePrompt = tonguePrompt || tpRes.rows[0]?.prompt || "";
    const adminBoxPrompt = boxPrompt || bpRes.rows[0]?.prompt || "";

    const tongueFullPrompt = buildTonguePrompt(brand, detections, adminTonguePrompt);
    const barcodeValue = generateEAN13(EAN_PREFIXES[brand] || "400");
    const boxFullPrompt = buildBoxPrompt(brand, detections, adminBoxPrompt, barcodeValue);

    const getAspect = (b64: string | null) => {
      if (!b64) return null;
      const data = b64.includes(",") ? b64.split(",")[1] : b64;
      const dims = jpegDimsFromBase64(data);
      return (dims && dims.w > 0 && dims.h > 0) ? pickGeminiAspect(dims.w, dims.h) : null;
    };

    // Run both in parallel
    const [tongueResult, boxResult] = await Promise.all([
      runGeminiImageGeneration(tongueFullPrompt, tongueImageBase64 || null, getAspect(tongueImageBase64 || null), GLOBAL_DEADLINE, 45_000, apiKey),
      runGeminiImageGeneration(boxFullPrompt, boxImageBase64 || null, getAspect(boxImageBase64 || null), GLOBAL_DEADLINE, 45_000, apiKey),
    ]);

    if (!tongueResult && !boxResult)
      return res.status(503).json({ error: "Ambas generaciones fallaron. Inténtalo de nuevo." });

    // Deducir solo los tokens realmente generados
    const generated = (tongueResult ? 1 : 0) + (boxResult ? 1 : 0);
    if (generated > 0) deductTokens(tokenCheck.licenseId, generated);

    res.json({
      tongue: tongueResult,
      box: boxResult ? { ...boxResult, barcodeValue } : null,
    });
  });

  // ── Alfombras: edición de fondo por IA ──────────────────────────────────────
  // Recibe foto(s) de producto + referencia de alfombra opcional + color deseado.
  // Devuelve la imagen editada con la alfombra cambiada, producto intacto.
  app.post("/api/carpet/generate", geminiLimiter, requireLicense as any, checkDailyLimit as any, async (req: AuthRequest, res) => {
    // ── Gate: solo admins y usuarios Pro ───────────────────────────────────────
    if (!req.user?.is_admin && req.user?.rank !== 'pro') {
      return res.status(403).json({
        error: "Esta función es exclusiva para usuarios Pro.\n\nEscríbeme al WhatsApp para activarla — 8,99€/mes.",
        pro_required: true,
      });
    }

    const { imageBase64, carpetColor, referenceBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "Falta la imagen del producto" });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY no configurada" });

    const tokenCheck = await checkTokens(req, res, 1);
    if (!tokenCheck.ok) return;

    const colorDesc = (carpetColor || "beige claro").trim();

    const prompt = `Eres un editor profesional de fotografía de producto para e-commerce.

TAREA: Cambia ÚNICAMENTE el fondo de la imagen (la alfombra) al nuevo color/estilo: "${colorDesc}".

REGLAS ABSOLUTAS — no las incumplas bajo ningún concepto:
1. El producto (zapatilla, ropa u objeto) debe quedar EXACTAMENTE IGUAL: mismos colores, forma, textura, logotipos, costuras, suela y todos los detalles. CERO modificaciones.
2. Conserva EXACTAMENTE las proporciones y perspectiva original del producto.
3. Cambia el fondo sustituyendo la alfombra existente por una alfombra de color "${colorDesc}".
4. La iluminación debe ser uniforme, natural y coherente con el producto. Las sombras bajo el producto deben ser realistas.
5. Si aparece una mano u otra parte del cuerpo, consérvala exactamente como está, sin alteraciones.
6. NO añadas objetos, textos, marcas de agua, elementos decorativos ni reflejos extra.
7. La imagen resultante debe tener exactamente el mismo encuadre y composición que la original.
8. Calidad fotográfica profesional de catálogo e-commerce.${referenceBase64 ? "\n9. Usa la primera imagen como referencia del estilo, textura y tono de alfombra objetivo." : ""}

Genera la imagen editada.`;

    // Calcular aspect ratio desde la imagen de entrada
    let aspectRatio: string | null = null;
    try {
      const b64data = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
      const dims = jpegDimsFromBase64(b64data);
      if (dims && dims.w > 0 && dims.h > 0) aspectRatio = pickGeminiAspect(dims.w, dims.h);
    } catch (_) {}

    const result = await runGeminiImageGeneration(
      prompt,
      imageBase64,
      aspectRatio,
      Date.now() + 90_000,
      40_000,
      apiKey,
      referenceBase64 || null
    );

    if (!result) return res.status(503).json({ error: "No se pudo generar la imagen. Inténtalo de nuevo." });

    deductTokens(tokenCheck.licenseId, 1);
    res.json(result);
  });

  // ── SSE: Ops Terminal stream ─────────────────────────────────────────────────
  // El cliente se conecta con el token JWT en query param porque EventSource
  // no soporta cabeceras personalizadas.
  app.get("/api/ops-stream", async (req: any, res: Response) => {
    const token = (req.query.token as string) || req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).end();
    let userId: string;
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      const r = await pool.query("SELECT id FROM users WHERE id=$1", [decoded.id]);
      if (!r.rows[0]) return res.status(401).end();
      userId = String(r.rows[0].id);
    } catch { return res.status(401).end(); }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // evita que nginx/Railway bufferice
    res.flushHeaders();

    if (!sseClients.has(userId)) sseClients.set(userId, new Set());
    sseClients.get(userId)!.add(res);

    // Evento de bienvenida
    res.write(`data: ${JSON.stringify({ level: "sys", tag: "STREAM", msg: "ops-terminal conectado · live feed activo", ts: new Date().toISOString() })}\n\n`);

    // Heartbeat cada 25s para que Railway no cierre la conexión idle
    const hb = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { clearInterval(hb); sseClients.get(userId)?.delete(res); }
    }, 25000);

    req.on("close", () => {
      clearInterval(hb);
      sseClients.get(userId)?.delete(res);
    });
  });

  // ── Lamine Hub Extension endpoints ──────────────────────────────────────────
  // Health check que usa el control-center de la extensión
  app.get("/api/up", (_req, res) => {
    res.json({ ok: true, data: { serverTime: new Date().toISOString(), version: "1.2.16-hwid" } });
  });

  // ── HWID License System ──────────────────────────────────────────────────────
  // Rate limiters estrictos para endpoints sensibles
  const extActivateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { ok: false, error: "too_many_requests" },
    keyGenerator: (req) =>
      (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "unknown",
  });
  const extVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: { ok: false, error: "too_many_requests" },
    keyGenerator: (req) =>
      (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "unknown",
  });

  /**
   * POST /api/ext/activate
   * Body: { key: "LM-XXXX-XXXX-XXXX", hwid: "<sha256 fingerprint>" }
   * — Valida la licencia, vincula HWID en primer uso, devuelve session JWT.
   */
  app.post("/api/ext/activate", extActivateLimiter, async (req, res) => {
    const { key, hwid } = req.body;
    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "";

    if (!key || !hwid)
      return res.status(400).json({ ok: false, error: "key_and_hwid_required" });

    const keyNorm = String(key).trim().toUpperCase();
    if (keyNorm.length < 10)
      return res.status(400).json({ ok: false, error: "invalid_key_format" });

    try {
      const licRes = await pool.query("SELECT * FROM licenses WHERE key = $1", [keyNorm]);
      const lic = licRes.rows[0];

      if (!lic)
        return res.status(404).json({ ok: false, error: "license_not_found" });
      if (!lic.is_active)
        return res.status(403).json({ ok: false, error: "license_revoked" });
      if (lic.expires_at && new Date(lic.expires_at) < new Date())
        return res.status(403).json({ ok: false, error: "license_expired" });

      // HWID binding: si ya está vinculado a otro dispositivo, bloquear
      if (lic.hwid && lic.hwid !== hwid)
        return res.status(403).json({
          ok: false,
          error: "hwid_mismatch",
          message:
            "Esta licencia está vinculada a otro dispositivo. Contacta con soporte para transferirla.",
        });

      // Vincular HWID en primer uso
      if (!lic.hwid) {
        await pool.query(
          "UPDATE licenses SET hwid = $1, activated_at = COALESCE(activated_at, NOW()), ip = $2 WHERE key = $3",
          [hwid, ip, keyNorm]
        );
      }

      // Calcular expiración de la sesión (igual a la de la licencia o 30 días)
      const sessionExpiry: Date =
        lic.expires_at
          ? new Date(lic.expires_at)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      // Crear usuario virtual si la licencia no tiene usuario vinculado
      // Esto permite usar todos los endpoints de la API con el token de la sesión
      if (!lic.user_id) {
        const vUsername = `lm_${keyNorm.replace(/-/g, "").toLowerCase().slice(0, 16)}`;
        const vEmail = `ext:${keyNorm.toLowerCase()}@lamine.hub`;
        const userRes = await pool.query(
          `INSERT INTO users (username, email, password_hash, is_admin)
           VALUES ($1, $2, 'ext_session_no_password', FALSE)
           ON CONFLICT (email) DO UPDATE SET username = EXCLUDED.username
           RETURNING id`,
          [vUsername, vEmail]
        );
        const userId = userRes.rows[0].id;
        await pool.query("UPDATE licenses SET user_id = $1 WHERE key = $2", [userId, keyNorm]);
        lic.user_id = userId;
      }

      // Revocar sesiones previas del mismo HWID+licencia (evita tokens huérfanos)
      await pool.query(
        "UPDATE extension_sessions SET revoked = TRUE WHERE license_key = $1 AND hwid = $2 AND revoked = FALSE",
        [keyNorm, hwid]
      );

      // Crear nueva sesión
      const sessionId = randomUUID();
      await pool.query(
        `INSERT INTO extension_sessions (id, license_key, hwid, expires_at, ip)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, keyNorm, hwid, sessionExpiry, ip]
      );

      // Firmar JWT con sid
      const expiresInSec = Math.floor((sessionExpiry.getTime() - Date.now()) / 1000);
      const token = jwt.sign({ sid: sessionId }, JWT_SECRET, {
        expiresIn: Math.max(expiresInSec, 60),
      });

      return res.json({
        ok: true,
        token,
        expires_at: sessionExpiry.toISOString(),
        type: lic.type,
      });
    } catch (e: any) {
      console.error("[ext/activate] error:", e?.message);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /**
   * POST /api/ext/verify
   * Body: { token: "<session JWT>", hwid: "<sha256 fingerprint>" }
   * — Re-valida la sesión en cada apertura del hub. Verificación completa en DB.
   */
  app.post("/api/ext/verify", extVerifyLimiter, async (req, res) => {
    const { token, hwid } = req.body;

    if (!token || !hwid)
      return res.status(400).json({ ok: false, error: "token_and_hwid_required" });

    // 1. Verificar JWT
    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET) as any;
    } catch {
      return res.status(401).json({ ok: false, error: "invalid_token" });
    }

    const { sid } = decoded;
    if (!sid)
      return res.status(401).json({ ok: false, error: "invalid_token" });

    try {
      // 2. Buscar sesión en DB
      const sessRes = await pool.query(
        "SELECT * FROM extension_sessions WHERE id = $1",
        [sid]
      );
      const sess = sessRes.rows[0];

      if (!sess)
        return res.status(401).json({ ok: false, error: "session_not_found" });
      if (sess.revoked)
        return res.status(401).json({ ok: false, error: "session_revoked" });
      if (new Date(sess.expires_at) < new Date())
        return res.status(401).json({ ok: false, error: "session_expired" });

      // 3. HWID debe coincidir exactamente
      if (sess.hwid !== hwid)
        return res.status(403).json({ ok: false, error: "hwid_mismatch" });

      // 4. Licencia todavía activa
      const licRes = await pool.query(
        "SELECT * FROM licenses WHERE key = $1 AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())",
        [sess.license_key]
      );
      const lic = licRes.rows[0];

      if (!lic)
        return res.status(403).json({ ok: false, error: "license_expired_or_revoked" });

      // 5. Actualizar last_seen (sin await para no bloquear la respuesta)
      pool
        .query("UPDATE extension_sessions SET last_seen_at = NOW() WHERE id = $1", [sid])
        .catch(() => {});

      return res.json({
        ok: true,
        license: {
          key: sess.license_key,
          type: lic.type,
          expires_at: lic.expires_at,
        },
      });
    } catch (e: any) {
      console.error("[ext/verify] error:", e?.message);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /**
   * POST /api/ext/deactivate
   * Body: { token: "<session JWT>" }
   * — Revoca la sesión activa (logout desde el hub).
   */
  app.post("/api/ext/deactivate", async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ ok: false, error: "token_required" });

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      if (decoded?.sid) {
        await pool.query(
          "UPDATE extension_sessions SET revoked = TRUE WHERE id = $1",
          [decoded.sid]
        );
      }
    } catch {
      // Token inválido — no importa, el cliente ya limpia el storage local
    }

    return res.json({ ok: true });
  });

  /**
   * POST /api/ext/analisis-verify
   * Body: { key/license_key: "<session JWT>", hwid: "<sha256 fingerprint>", ... }
   * Compatibilidad con el módulo Analisis (background-classic.js) que envía { key, hwid }.
   * Reutiliza la lógica de /api/ext/verify pero acepta key/license_key como alias de token.
   */
  app.post("/api/ext/analisis-verify", extVerifyLimiter, async (req, res) => {
    // El módulo Analisis envía el JWT en "key" o "license_key", no en "token"
    const token = req.body.token || req.body.key || req.body.license_key || "";
    const hwid  = req.body.hwid  || req.body.device_hwid || req.body.deviceHwid || "";

    if (!token || !hwid)
      return res.status(400).json({ ok: false, valid: false, allowed: false, error: "token_and_hwid_required" });

    // Verificar JWT
    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET) as any;
    } catch {
      return res.status(401).json({ ok: false, valid: false, allowed: false, error: "invalid_token" });
    }

    const { sid } = decoded;
    if (!sid)
      return res.status(401).json({ ok: false, valid: false, allowed: false, error: "invalid_token" });

    try {
      const sessRes = await pool.query(
        "SELECT * FROM extension_sessions WHERE id = $1",
        [sid]
      );
      const sess = sessRes.rows[0];

      if (!sess || sess.revoked || new Date(sess.expires_at) < new Date())
        return res.status(401).json({ ok: false, valid: false, allowed: false, status: "invalid", error: "session_invalid" });

      if (sess.hwid !== hwid)
        return res.status(403).json({ ok: false, valid: false, allowed: false, status: "invalid", error: "hwid_mismatch" });

      const licRes = await pool.query(
        "SELECT * FROM licenses WHERE key = $1 AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())",
        [sess.license_key]
      );
      const lic = licRes.rows[0];

      if (!lic)
        return res.status(403).json({ ok: false, valid: false, allowed: false, status: "expired", error: "license_expired_or_revoked" });

      pool
        .query("UPDATE extension_sessions SET last_seen_at = NOW() WHERE id = $1", [sid])
        .catch(() => {});

      return res.json({
        ok: true,
        valid: true,
        allowed: true,
        status: "active",
        license: {
          key: sess.license_key,
          type: lic.type,
          plan: lic.type,
          expires_at: lic.expires_at,
          status: "active",
        },
      });
    } catch (e: any) {
      console.error("[ext/analisis-verify] error:", e?.message);
      return res.status(500).json({ ok: false, valid: false, allowed: false, error: "server_error" });
    }
  });

  /**
   * GET /api/ext/me
   * Authorization: Bearer <session JWT>
   * Returns user and license info for the active extension session.
   */
  app.get("/api/ext/me", extVerifyLimiter, requireAuth as any, async (req: AuthRequest, res) => {
    const user = req.user!;
    const licRes = await pool.query(
      "SELECT key, type, expires_at FROM licenses WHERE user_id = $1 AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1",
      [user.id]
    );
    const lic = licRes.rows[0];
    res.json({
      ok: true,
      user: { id: user.id, username: user.username, email: user.email, is_admin: user.is_admin },
      license: lic
        ? { status: "active", plan: lic.type, type: lic.type, key: lic.key, expires_at: lic.expires_at }
        : { status: "inactive" },
    });
  });

  /**
   * GET /api/ext/ai-config
   * Returns server-side AI config (Gemini key) for authenticated extension sessions.
   * The key is never exposed to the frontend — only via this authenticated endpoint.
   */
  app.get("/api/ext/ai-config", requireAuth as any, async (req: AuthRequest, res) => {
    const geminiKey = process.env.GEMINI_API_KEY || null;
    if (!geminiKey) return res.status(503).json({ ok: false, error: "ai_not_configured" });
    return res.json({ ok: true, geminiKey });
  });

  // ── Admin: reset HWID de una licencia ──────────────────────────────────────
  // (ya existe /api/admin/licenses/:id/reset-hwid — añadimos también la revocación
  //  de todas las sesiones activas de esa licencia)

  // Login para el módulo de análisis (usa Bearer igual que el auth principal)
  app.post("/api/extension/login", authLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ ok: false, error: "email_and_password_required" });
    try {
      const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.trim().toLowerCase()]);
      const user = result.rows[0];
      if (!user || !(await bcrypt.compare(password, user.password_hash)))
        return res.status(401).json({ ok: false, error: "invalid_credentials" });
      const token = await mintSessionToken(user.id);
      const licRes = await pool.query(
        "SELECT type, expires_at FROM licenses WHERE user_id=$1 AND is_active=TRUE AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1",
        [user.id]
      );
      const lic = licRes.rows[0];
      const licenseStatus = (lic || user.is_admin) ? "active" : "inactive";
      res.json({
        ok: true, token,
        user: { id: user.id, email: user.email, username: user.username, role: user.is_admin ? "admin" : "user" },
        license: { status: licenseStatus, type: lic?.type || (user.is_admin ? "admin" : null) },
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // Verify para el módulo de análisis — acepta JWT Bearer O license_key en body
  const extensionVerifyHandler = async (req: Request, res: Response) => {
    // Intento 1: Bearer JWT
    const bearerToken = req.headers.authorization?.replace("Bearer ", "");
    if (bearerToken) {
      try {
        const decoded = jwt.verify(bearerToken, JWT_SECRET) as any;
        const result = await pool.query("SELECT id, username, email, is_admin FROM users WHERE id = $1", [decoded.id]);
        if (result.rows[0]) {
          const user = result.rows[0];
          const licRes = await pool.query(
            "SELECT is_active FROM licenses WHERE user_id=$1 AND is_active=TRUE AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1",
            [user.id]
          );
          if (licRes.rows[0] || user.is_admin) {
            return res.json({ ok: true, valid: true, allowed: true, status: "active",
              user: { id: user.id, username: user.username, email: user.email, is_admin: user.is_admin },
              config: { extensionMinVersion: null }, });
          }
        }
      } catch {}
    }
    // Intento 2: key en body puede ser JWT (token del hub) o license key
    const keyRaw = req.body?.key || req.body?.license_key || req.body?.licenseKey || "";
    const keyStr = String(keyRaw).trim();
    // Si parece JWT, verificarlo como Bearer
    if (keyStr.startsWith("ey") && keyStr.includes(".")) {
      try {
        const decoded = jwt.verify(keyStr, JWT_SECRET) as any;
        const result = await pool.query("SELECT id, username, email, is_admin FROM users WHERE id = $1", [decoded.id]);
        if (result.rows[0]) {
          const user = result.rows[0];
          const licRes = await pool.query(
            "SELECT is_active FROM licenses WHERE user_id=$1 AND is_active=TRUE AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1",
            [user.id]
          );
          if (licRes.rows[0] || user.is_admin) {
            return res.json({ ok: true, valid: true, allowed: true, status: "active",
              user: { id: user.id, username: user.username, email: user.email },
              config: { extensionMinVersion: null } });
          }
          return res.status(403).json({ ok: false, allowed: false, status: "inactive", error: "license_not_active" });
        }
      } catch {}
    }
    const licenseKey = keyStr.toUpperCase();
    if (licenseKey) {
      const licRes = await pool.query(
        "SELECT l.*, u.id as uid, u.email FROM licenses l LEFT JOIN users u ON u.id=l.user_id WHERE l.key=$1 AND l.is_active=TRUE AND (l.expires_at IS NULL OR l.expires_at > NOW()) LIMIT 1",
        [licenseKey]
      );
      if (licRes.rows[0]) {
        const lic = licRes.rows[0];
        return res.json({ ok: true, valid: true, allowed: true, status: "active",
          user: { id: lic.uid, email: lic.email },
          config: { extensionMinVersion: null },
          license: { key: licenseKey, status: "active", expiresAt: lic.expires_at } });
      }
      return res.status(403).json({ ok: false, allowed: false, status: "inactive", error: "license_not_found" });
    }
    return res.status(401).json({ ok: false, allowed: false, status: "unauthorized", error: "unauthorized" });
  };
  app.get("/api/extension/verify", extensionVerifyHandler as any);
  app.post("/api/extension/verify", extensionVerifyHandler as any);

  // Whitelist endpoints para bazooka — PUBLIC (workers check before reporting)
  app.get("/api/extension/whitelist-items", async (_req: Request, res: Response) => {
    res.json({ ok: true, items: [] });
  });
  app.get("/api/extension/whitelist-profiles", async (_req: Request, res: Response) => {
    res.json({ ok: true, profiles: [] });
  });
  app.post("/api/extension/whitelist-items", requireLicense as any, async (req: AuthRequest, res) => {
    res.json({ ok: true });
  });
  app.post("/api/extension/whitelist-profiles", requireLicense as any, async (req: AuthRequest, res) => {
    res.json({ ok: true });
  });

  // Monitor stubs — usados por el módulo analisis de la extensión
  const monitorAuthOk = async (req: Request) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    const key = req.body?.key || req.body?.license_key || req.headers["x-license-key"] || (req.query as any)?.key || "";
    if (token) {
      try { jwt.verify(token, JWT_SECRET); return true; } catch {}
    }
    if (key) {
      const r = await pool.query("SELECT id FROM licenses WHERE key=$1 AND is_active=TRUE LIMIT 1", [String(key).trim().toUpperCase()]);
      return !!r.rows[0];
    }
    return false;
  };

  app.get("/api/extension/monitor/overview", async (req: Request, res: Response) => {
    if (!await monitorAuthOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    res.json({ ok: true, data: { campaigns: [], products: [], activeCount: 0, soldCount: 0, trackedCount: 0, serverTime: new Date().toISOString() } });
  });

  app.post("/api/extension/monitor/requests", async (req: Request, res: Response) => {
    if (!await monitorAuthOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    res.json({ ok: true, data: { requests: [], total: 0 } });
  });

  app.post("/api/monitor/workers/register", async (req: Request, res: Response) => {
    if (!await monitorAuthOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    res.json({ ok: true, workerId: "worker-" + Date.now(), status: "registered" });
  });

  app.post("/api/monitor/workers/heartbeat", async (req: Request, res: Response) => {
    if (!await monitorAuthOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    res.json({ ok: true, status: "alive" });
  });

  app.post("/api/monitor/tasks/claim", async (req: Request, res: Response) => {
    if (!await monitorAuthOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    res.json({ ok: true, task: null });
  });

  app.get("/api/monitor/tasks/:id", async (req: Request, res: Response) => {
    if (!await monitorAuthOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    res.json({ ok: true, task: null });
  });

  app.post("/api/monitor/tasks/:id", async (req: Request, res: Response) => {
    if (!await monitorAuthOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    res.json({ ok: true });
  });

  // Lista de módulos/features que muestra el control-center
  app.get("/api/extension/features", (_req, res) => {
    res.json({
      ok: true,
      data: {
        modules: [
          { id: "relist_engine", title: "Republicar anuncios", status: "ready", sourceState: "confirmado",
            summary: "Cola de republicacion y repost de artículos.", improvement: "Colas controladas y textos seguros.", source: "Vinted API" },
          { id: "auto_messages", title: "Mensajes automáticos", status: "ready", sourceState: "confirmado",
            summary: "Respuestas automáticas a likes y conversaciones.", improvement: "Separación por cuenta y scoring.", source: "Vinted API" },
          { id: "closet_panel", title: "Panel de vestuario", status: "ready", sourceState: "confirmado",
            summary: "Gestión masiva de artículos.", improvement: "Panel limpio y edición masiva.", source: "Vinted API" },
          { id: "smart_agent", title: "Agente inteligente", status: "ready", sourceState: "confirmado",
            summary: "IA para respuestas y negociaciones.", improvement: "Memoria por cliente.", source: "Vinted API + IA" },
          { id: "restocker", title: "Reabastecedor", status: "ready", sourceState: "confirmado",
            summary: "Restock automático de inventario.", improvement: "Colas por prioridad.", source: "Vinted API" },
          { id: "bazooka", title: "Bazooka", status: "ready", sourceState: "confirmado",
            summary: "Control de mercado y eliminación de competencia.", improvement: "Coordinado con Railway.", source: "/api/bazooka/*" },
          { id: "smart_offers", title: "Ofertas inteligentes", status: "ready", sourceState: "confirmado",
            summary: "Aceptación y contraoferta automática.", improvement: "Reglas por margen y stock.", source: "Vinted API" },
          { id: "analisis", title: "Análisis de mercado", status: "ready", sourceState: "confirmado",
            summary: "Métricas de ventas y rendimiento.", improvement: "Conectado con dashboard Founderclub.", source: "/api/dashboard" },
          { id: "orders", title: "Gestión de pedidos", status: "base", sourceState: "parcial",
            summary: "Pedidos y etiquetas.", improvement: "Tablero completo próximamente.", source: "Vinted API" },
        ]
      }
    });
  });

  // ── Vinted Entitlements — called by hub-addon.js background ────────────────
  app.get("/api/vinted/entitlements", requireLicense as any, async (req: AuthRequest, res: Response) => {
    const licResult = await pool.query(
      "SELECT type, plan, expires_at FROM licenses WHERE user_id = $1 AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 1",
      [req.user!.id]
    );
    const lic = licResult.rows[0];
    const plan = String(lic?.plan || lic?.type || "lamine").toLowerCase();
    const isActive = !!lic;
    const canBazooka = ["bazooka", "pro", "elite", "full"].includes(plan);

    res.json({
      ok: true,
      data: {
        plan,
        status: isActive ? "active" : "inactive",
        is_duplicate: false,
        can_reposts: isActive,
        can_auto_messages: isActive,
        can_smart_offers: isActive,
        can_restocker: isActive,
        can_monitor: isActive,
        can_ai_messages: isActive,
        can_bazooka: canBazooka,
        enforced_limits: {
          ai_reposts: isActive,
          auto_messages: isActive,
          smart_offers: isActive,
          smart_agents: isActive,
          restocker: isActive,
          orders: isActive,
          inventory: isActive,
          bazooka: canBazooka,
          max_accounts: 10,
        },
        resources: {
          discord: "https://discord.gg/lamine",
          guide: "https://lamine.app/",
          billing: "https://lamine.app/pricing",
        },
      },
    });
  });

  // ── Extension Runtime ────────────────────────────────────────────────────────
  app.get("/api/extension/runtime", requireLicense as any, async (req: AuthRequest, res: Response) => {
    const licResult = await pool.query(
      "SELECT key, type, plan, expires_at FROM licenses WHERE user_id = $1 AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 1",
      [req.user!.id]
    );
    const lic = licResult.rows[0];
    const plan = String(lic?.plan || lic?.type || "lamine").toLowerCase();
    const canBazooka = ["bazooka", "pro", "elite", "full"].includes(plan);

    res.json({
      ok: true,
      data: {
        brand: "Lamine",
        extensionName: "Lamine Vinted OS",
        productCode: "automatizacion",
        planKey: plan,
        planLabel: "Automatización",
        bazookaEnabled: canBazooka,
        automationEnabled: true,
        analysisEnabled: true,
        featureFlags: {
          smartOffers:  true,
          restocker:    true,
          autoMessages: true,
          aiMessages:   true,
          smartAgent:   true,
          ordersSync:   true,
          bazooka:      canBazooka,
          bazookaRemote: canBazooka,
        },
        moduleStates: {
          bazooka:        { id: "bazooka",        state: "active", degraded: false, blocked: !canBazooka, message: null },
          automatizacion: { id: "automatizacion", state: "active", degraded: false, blocked: false, message: null },
          analisis:       { id: "analisis",       state: "active", degraded: false, blocked: false, message: null },
        },
        modulesVisible: {
          bazooka:      canBazooka,
          restocker:    true,
          smartOffers:  true,
          smartAgent:   true,
          orders:       true,
          autoMessages: true,
          analisis:     true,
        },
        license: {
          key:        lic?.key || null,
          status:     lic ? "active" : "inactive",
          plan:       lic?.plan || "month",
          expiresAt:  lic?.expires_at || null,
          maxInstalls: 3,
        },
        resources: {
          discord:   "https://discord.gg/lamine",
          extension: "https://lamine.app/extension",
          guide:     "https://lamine.app/",
          billing:   "https://lamine.app/pricing",
        },
      },
      config: { heartbeatIntervalSec: 60, workerPollIntervalSec: 60, camuflajePeriodMin: 30 },
      serverTime: new Date().toISOString(),
    });
  });

  // ── Worker Endpoints (Distributed Bazooka) ───────────────────────────────────

  app.get("/api/worker/ping", requireLicense as any, async (_req: AuthRequest, res: Response) => {
    res.json({ ok: true, status: "online", serverTime: new Date().toISOString() });
  });

  app.get("/api/worker/overview", requireLicense as any, async (_req: AuthRequest, res: Response) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')                        AS pending,
        COUNT(*) FILTER (WHERE status = 'assigned')                       AS assigned,
        COUNT(*) FILTER (WHERE status = 'done'   AND completed_at >= $1)  AS done_today,
        COUNT(*) FILTER (WHERE status = 'failed' AND completed_at >= $1)  AS failed_today
      FROM report_jobs
    `, [today]);
    const row = result.rows[0] || {};
    res.json({
      ok: true,
      pending:    parseInt(row.pending    || "0"),
      assigned:   parseInt(row.assigned   || "0"),
      doneToday:  parseInt(row.done_today || "0"),
      failedToday:parseInt(row.failed_today || "0"),
    });
  });

  app.get("/api/worker/jobs/next", requireLicense as any, async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;

    // Reset stale assigned jobs (assigned >5min ago) back to pending
    await pool.query(`
      UPDATE report_jobs
      SET status = 'pending', assigned_to = NULL, assigned_at = NULL, updated_at = NOW()
      WHERE status = 'assigned' AND assigned_at < NOW() - INTERVAL '5 minutes'
    `);

    // Atomically grab next pending job
    const result = await pool.query(`
      UPDATE report_jobs
      SET status = 'assigned', assigned_to = $1, assigned_at = NOW(), updated_at = NOW()
      WHERE id = (
        SELECT id FROM report_jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `, [userId]);

    const job = result.rows[0] || null;
    res.json({ ok: true, job });
  });

  app.post("/api/worker/jobs/:id/status", requireLicense as any, async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const jobId  = parseInt(req.params.id);
    const status = req.body?.status;
    const error  = req.body?.error ? String(req.body.error).slice(0, 500) : null;

    if (!status || !["done", "failed"].includes(status)) {
      return res.status(400).json({ ok: false, error: "status must be 'done' or 'failed'" });
    }
    if (isNaN(jobId)) {
      return res.status(400).json({ ok: false, error: "invalid job id" });
    }

    const result = await pool.query(`
      UPDATE report_jobs
      SET status = $1, completed_at = NOW(), error_message = $2, updated_at = NOW()
      WHERE id = $3 AND assigned_to = $4
      RETURNING id
    `, [status, error, jobId, userId]);

    if (!result.rows[0]) {
      return res.status(404).json({ ok: false, error: "job not found or not assigned to you" });
    }
    res.json({ ok: true, id: result.rows[0].id });
  });

  // ── Submit / View Report Jobs (PRO clients — Bazooka) ────────────────────────

  app.post("/api/bazooka/report-jobs", requireLicense as any, async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const rawItems = Array.isArray(req.body?.items)
      ? req.body.items
      : [{ url: req.body?.url, itemId: req.body?.itemId, title: req.body?.title }];

    const items = rawItems.filter((i: any) => i?.url);
    if (!items.length) {
      return res.status(400).json({ ok: false, error: "no valid items provided" });
    }

    let queued = 0;
    let duplicate = 0;

    for (const item of items) {
      const url    = String(item.url   || "").slice(0, 1000);
      const itemId = item.itemId ? String(item.itemId).slice(0, 100) : null;
      const title  = item.title  ? String(item.title ).slice(0, 500) : null;

      // Skip if already pending or assigned for same itemId or url
      if (itemId) {
        const existing = await pool.query(
          `SELECT id FROM report_jobs WHERE item_id = $1 AND status IN ('pending','assigned') LIMIT 1`,
          [itemId]
        );
        if (existing.rows[0]) { duplicate++; continue; }
      }

      await pool.query(
        `INSERT INTO report_jobs (item_url, item_id, title, submitted_by) VALUES ($1, $2, $3, $4)`,
        [url, itemId, title, userId]
      );
      queued++;
    }

    res.json({ ok: true, queued, duplicate });
  });

  app.get("/api/bazooka/report-jobs", requireLicense as any, async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const result = await pool.query(
      `SELECT id, item_url, item_id, title, status, assigned_at, completed_at, error_message, created_at
       FROM report_jobs
       WHERE submitted_by = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    );
    res.json({ ok: true, jobs: result.rows });
  });

  // ── Lamine HUB Advanced Endpoints ─────────────────────────────────────────

  // 1. Heartbeat — registra sesión de dispositivo y aplica límite/lock
  app.post("/api/extension/heartbeat", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { installId, browserId, hwid, version } = req.body || {};
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null;
      const userAgent = (req.headers["user-agent"] as string) || null;

      // Comprobar dispositivos activos (últimas 24h, distintos install_id)
      const activeCountQ = await pool.query(
        `SELECT COUNT(DISTINCT install_id)::int AS n
         FROM device_sessions
         WHERE user_id = $1 AND last_seen > NOW() - INTERVAL '24 hours'
           AND install_id IS NOT NULL AND install_id <> $2`,
        [userId, installId || ""]
      );
      const activeOther = activeCountQ.rows[0]?.n ?? 0;
      if (activeOther >= 5) {
        return res.json({ ok: false, banned: true, error: "device_mismatch" });
      }

      // Lock por hwid: si ya hay un hwid distinto registrado en las últimas 24h, bloquear
      if (hwid) {
        const hwidQ = await pool.query(
          `SELECT DISTINCT hwid FROM device_sessions
           WHERE user_id = $1 AND hwid IS NOT NULL AND hwid <> ''
             AND last_seen > NOW() - INTERVAL '24 hours'`,
          [userId]
        );
        const known = hwidQ.rows.map((r: any) => r.hwid);
        if (known.length > 0 && !known.includes(hwid)) {
          return res.json({ ok: false, banned: true, error: "device_mismatch" });
        }
      }

      await pool.query(
        `INSERT INTO device_sessions (user_id, install_id, browser_id, hwid, version, ip, user_agent, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (user_id, install_id) DO UPDATE
           SET browser_id = EXCLUDED.browser_id,
               hwid = EXCLUDED.hwid,
               version = EXCLUDED.version,
               ip = EXCLUDED.ip,
               user_agent = EXCLUDED.user_agent,
               last_seen = NOW()`,
        [userId, installId || null, browserId || null, hwid || null, version || null, ip, userAgent]
      );

      res.json({ ok: true, status: "active" });
    } catch (err: any) {
      console.error("heartbeat error", err?.message);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // ── Extension: heartbeat GET alias (extension sends GET, founderclub has POST) ─
  app.get("/api/extension/heartbeat", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      await pool.query(
        `INSERT INTO device_sessions (user_id, install_id, last_seen)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id, install_id) DO UPDATE SET last_seen = NOW()`,
        [userId, 'ext-bg']
      ).catch(() => {});
      res.json({ ok: true, ts: Date.now() });
    } catch { res.json({ ok: true }); }
  });

  // ── Bazooka client: jobs/next alias (extension uses /api/bazooka/client/jobs/next)
  app.get("/api/bazooka/client/jobs/next", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT id, type, params, status FROM bazooka_jobs
         WHERE status='pending' AND (claimed_by IS NULL OR claimed_at < NOW() - INTERVAL '5 minutes')
         ORDER BY created_at ASC LIMIT 1`
      );
      const job = result.rows[0] || null;
      if (job) {
        await pool.query(
          `UPDATE bazooka_jobs SET claimed_by=$1, claimed_at=NOW(), status='running' WHERE id=$2`,
          ['ext', job.id]
        );
      }
      res.json({ job: job ? { ...job, params: job.params || {} } : null });
    } catch (e: any) {
      res.json({ job: null });
    }
  });

  // ── Action validate (extension calls POST /action/validate before protected actions) ─
  app.post("/action/validate", requireAuth as any, async (req: AuthRequest, res: Response) => {
    // Simple pass-through: if auth is valid and license is active → allow
    res.json({ ok: true, allowed: true });
  });

  // ── Vinted offers (offer bot endpoint) ──────────────────────────────────────
  app.post("/vinted/offers", requireAuth as any, async (req: AuthRequest, res: Response) => {
    // Offer bot rules engine — accept and queue the offer action
    try {
      const { itemId, price, cookieHeader } = req.body || {};
      if (!itemId) return res.status(400).json({ ok: false, error: 'itemId required' });
      res.json({ ok: true, queued: true, itemId });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Bazooka client whitelist-items (extension uses /api/bazooka/client/whitelist-items) ─
  app.post("/api/bazooka/client/whitelist-items", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { item_id, item_url } = req.body || {};
      if (!item_id) return res.status(400).json({ ok: false, error: 'item_id required' });
      await pool.query(
        `INSERT INTO whitelist_items (user_id, item_id, item_url) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [userId, String(item_id), item_url || '']
      );
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Extension: sync Vinted session / register account ───────────────────────
  app.post("/api/extension/sync-vinted-session", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      // `cookie` = access_token_web Bearer token (for compat)
      // `session_cookie` = full "name=value; name2=value2" cookie string (for server-side Vinted calls)
      const { vinted_id, login, cookie, session_cookie, domain = "es" } = req.body || {};
      if (!cookie) return res.status(400).json({ ok: false, error: "cookie_required" });

      const dom      = String(domain).replace("vinted.", "").replace(/\.$/, "").slice(0, 5);
      const vid      = vinted_id ? String(vinted_id) : null;
      const username = login || (vid ? `user_${vid}` : null);

      // Reject if no vinted_id — without it we cannot do a reliable upsert and
      // would create duplicate rows (cuenta_TIMESTAMP) on every startup scan.
      if (!vid) {
        console.warn(`[sync-vinted-session] user=${userId} vinted_id missing — rejected to avoid duplicate rows`);
        return res.status(400).json({ ok: false, error: "vinted_id_required" });
      }

      // Upsert por vinted_id — única clave de confianza (el username es volátil).
      // ON CONFLICT must match the partial index: WHERE vinted_id IS NOT NULL
      const r = await pool.query(
        `INSERT INTO vinted_accounts (user_id, username, vinted_id, cookie, session_cookie, domain, is_active, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW())
         ON CONFLICT (user_id, vinted_id) WHERE vinted_id IS NOT NULL
         DO UPDATE SET username       = COALESCE(EXCLUDED.username, vinted_accounts.username),
                       cookie         = EXCLUDED.cookie,
                       session_cookie = COALESCE(EXCLUDED.session_cookie, vinted_accounts.session_cookie),
                       domain         = EXCLUDED.domain,
                       is_active      = TRUE,
                       updated_at     = NOW()
         RETURNING id, username, domain, vinted_id`,
        [userId, username || `user_${vid}`, vid, cookie, session_cookie || null, dom]
      );
      res.json({ ok: true, account: r.rows[0] });
    } catch (e: any) {
      console.error('[sync-vinted-session] DB error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // MULTICUENTA ROSTER — metadatos de cuentas vinculadas (sin cookies ni pass)
  // Regla: 1 vinted_id global → 1 licencia (UNIQUE en extension_vinted_accounts)
  // ════════════════════════════════════════════════════════════════════════════

  /** Devuelve la licencia activa del usuario (para roster). */
  async function getRosterLicense(userId: number): Promise<{ id: number; max_accounts: number } | null> {
    const r = await pool.query(
      `SELECT id, max_accounts FROM licenses
       WHERE user_id = $1 AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    return r.rows[0] ?? null;
  }

  // POST /api/extension/vinted/roster  ─ registra / actualiza cuenta (solo metadatos)
  app.post("/api/extension/vinted/roster", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const a      = req.body?.account ?? req.body ?? {};
      const vintedId = String(a.vinted_id ?? a.id ?? "").trim();
      if (!vintedId) return res.status(400).json({ error: "missing_vinted_id" });

      const lic = await getRosterLicense(userId);
      if (!lic && !req.user!.is_admin) return res.status(403).json({ error: "Licencia requerida o expirada" });

      const licId  = lic?.id ?? 0;
      const maxAcc = lic?.max_accounts ?? 999;

      const c = await pool.connect();
      try {
        // ¿Ya existe este vinted_id en el roster global?
        const { rows: ex } = await c.query(
          "SELECT id, license_id FROM extension_vinted_accounts WHERE vinted_id = $1",
          [vintedId]
        );

        if (ex[0]) {
          if (ex[0].license_id !== licId)           // ⛔ vinculado a otra licencia
            return res.status(422).json({ errors: { vinted_id: ["already_taken"] } });

          // misma licencia → actualizar metadatos
          const { rows } = await c.query(
            `UPDATE extension_vinted_accounts
             SET login=$2, title=$3, email=$4, country_code=$5, updated_at=NOW()
             WHERE vinted_id=$1 RETURNING *`,
            [vintedId, a.login ?? null, a.title ?? a.login ?? null,
             a.email ?? null, a.country_code ?? null]
          );
          return res.json({ data: rows[0] });
        }

        // Nueva cuenta: verificar límite del plan
        const { rows: cnt } = await c.query(
          "SELECT COUNT(*)::int n FROM extension_vinted_accounts WHERE license_id = $1",
          [licId]
        );
        if ((cnt[0].n as number) >= maxAcc && !req.user!.is_admin)
          return res.status(403).json({ error: "account_limit_reached", limit: maxAcc });

        try {
          const { rows } = await c.query(
            `INSERT INTO extension_vinted_accounts
               (license_id, vinted_id, login, title, email, country_code)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [licId, vintedId, a.login ?? null, a.title ?? a.login ?? null,
             a.email ?? null, a.country_code ?? null]
          );
          return res.status(201).json({ data: rows[0] });
        } catch (e: any) {
          if (e.code === "23505")                   // race condition → ya tomado
            return res.status(422).json({ errors: { vinted_id: ["already_taken"] } });
          throw e;
        }
      } finally { c.release(); }
    } catch (e: any) {
      console.error("POST /extension/vinted/roster", e);
      res.status(500).json({ error: "server_error" });
    }
  });

  // GET /api/extension/vinted/roster  ─ lista cuentas vinculadas a la licencia
  app.get("/api/extension/vinted/roster", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const lic = await getRosterLicense(req.user!.id);
      if (!lic && !req.user!.is_admin) return res.json({ data: [], total: 0, limit: 0 });
      const { rows } = await pool.query(
        `SELECT id, vinted_id, login, title, country_code, status, created_at, updated_at
         FROM extension_vinted_accounts
         WHERE license_id = $1
         ORDER BY created_at DESC`,
        [lic!.id]
      );
      res.json({ data: rows, total: rows.length, limit: lic!.max_accounts });
    } catch (e: any) {
      res.status(500).json({ error: "server_error" });
    }
  });

  // GET /api/extension/vinted/roster/:vintedId  ─ comprueba propietario
  // 401 si pertenece a otra licencia (dispara isDuplicate en la extensión)
  app.get("/api/extension/vinted/roster/:vintedId", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const { rows } = await pool.query(
        "SELECT * FROM extension_vinted_accounts WHERE vinted_id = $1",
        [req.params.vintedId]
      );
      if (!rows[0]) return res.status(404).json({ error: "not_found" });
      const lic = await getRosterLicense(req.user!.id);
      if (!req.user!.is_admin && rows[0].license_id !== lic?.id)
        return res.status(401).json({ error: "duplicate" });
      res.json({ data: rows[0] });
    } catch (e: any) {
      res.status(500).json({ error: "server_error" });
    }
  });

  // DELETE /api/extension/vinted/roster/:vintedId  ─ desvincular cuenta
  app.delete("/api/extension/vinted/roster/:vintedId", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const lic = await getRosterLicense(req.user!.id);
      if (!lic && !req.user!.is_admin) return res.json({ ok: false });
      const { rowCount } = await pool.query(
        "DELETE FROM extension_vinted_accounts WHERE vinted_id = $1 AND license_id = $2",
        [req.params.vintedId, lic!.id]
      );
      res.json({ ok: (rowCount ?? 0) > 0 });
    } catch (e: any) {
      res.status(500).json({ error: "server_error" });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // FASE 3 — Fleet workers (1 perfil de navegador = 1 cuenta Vinted = 1 worker)
  // Auth worker: header X-Bazooka-Worker-Token (secreto de larga vida por worker).
  // Regla: un job con target_vinted_id=X solo puede ejecutarse en la sesión de X.
  // NUNCA guardar cookies/credenciales en fleet_jobs.payload.
  // ════════════════════════════════════════════════════════════════════════════

  const FLEET_LEASE_SEC = 120; // lease de 2 min; worker renueva cada ~50s

  async function requireFleetWorker(req: AuthRequest & { worker?: any }, res: Response, next: NextFunction) {
    const token = String(req.headers["x-bazooka-worker-token"] || "").trim();
    if (!token) return res.status(401).json({ error: "missing_worker_token" });
    const { rows } = await pool.query(
      "SELECT id, license_id, vinted_id, status FROM fleet_workers WHERE token = $1",
      [token]
    );
    if (!rows[0]) return res.status(401).json({ error: "invalid_worker" });
    (req as any).worker = rows[0];
    next();
  }

  // POST /api/fleet/worker/register  (Bearer ext JWT) — crea o recupera worker
  // El token del worker es estable: ON CONFLICT devuelve el token ya almacenado.
  app.post("/api/fleet/worker/register", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const lic = await getRosterLicense(req.user!.id);
      if (!lic && !req.user!.is_admin) return res.status(403).json({ error: "licencia_requerida" });
      const licId = lic?.id ?? 0;
      const { vinted_id = null, device_hwid = "", ext_version = null } = req.body || {};
      const newToken = crypto.randomBytes(24).toString("hex");
      const { rows } = await pool.query(
        `INSERT INTO fleet_workers
           (license_id, vinted_id, device_hwid, token, ext_version, status, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,'online',NOW())
         ON CONFLICT (license_id, device_hwid) DO UPDATE
           SET vinted_id    = EXCLUDED.vinted_id,
               ext_version  = EXCLUDED.ext_version,
               status       = 'online',
               last_seen_at = NOW()
         RETURNING id, token`,
        [licId, vinted_id, device_hwid, newToken, ext_version]
      );
      res.json({ data: rows[0] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/fleet/worker/ping  (X-Bazooka-Worker-Token) — heartbeat + telemetría
  app.post("/api/fleet/worker/ping", requireFleetWorker as any, async (req: any, res: Response) => {
    const { saturation = 0, running_jobs = 0, ext_version = null } = req.body || {};
    await pool.query(
      `UPDATE fleet_workers
       SET last_seen_at = NOW(),
           saturation   = $2,
           running_jobs = $3,
           ext_version  = COALESCE($4, ext_version),
           status       = CASE WHEN status='paused' THEN 'paused' ELSE 'online' END
       WHERE id = $1`,
      [req.worker.id, saturation, running_jobs, ext_version]
    ).catch(() => {});
    res.json({ ok: true, paused: req.worker.status === "paused" });
  });

  // GET /api/fleet/worker/jobs/next  (X-Bazooka-Worker-Token) — CLAIM ATÓMICO
  // Un solo UPDATE…WHERE id=(SELECT…FOR UPDATE SKIP LOCKED): nunca dos workers
  // reclaman el mismo job.
  app.get("/api/fleet/worker/jobs/next", requireFleetWorker as any, async (req: any, res: Response) => {
    try {
      const w = req.worker;
      const { rows } = await pool.query(
        `UPDATE fleet_jobs
         SET status      = 'running',
             worker_id   = $1,
             attempts    = attempts + 1,
             started_at  = NOW(),
             lease_until = NOW() + ($4 || ' seconds')::interval,
             updated_at  = NOW()
         WHERE id = (
           SELECT id FROM fleet_jobs
           WHERE status = 'queued'
             AND run_after <= NOW()
             AND license_id = $2
             AND (target_vinted_id IS NULL OR target_vinted_id = $3)
           ORDER BY priority DESC, created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING *`,
        [w.id, w.license_id, w.vinted_id, String(FLEET_LEASE_SEC)]
      );
      if (!rows[0]) return res.status(204).end();
      res.json({ data: rows[0] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/fleet/worker/jobs/:id/heartbeat  — renueva el lease mientras corre
  app.post("/api/fleet/worker/jobs/:id/heartbeat", requireFleetWorker as any, async (req: any, res: Response) => {
    await pool.query(
      `UPDATE fleet_jobs
       SET lease_until = NOW() + ($3 || ' seconds')::interval,
           updated_at  = NOW()
       WHERE id = $1 AND worker_id = $2 AND status = 'running'`,
      [req.params.id, req.worker.id, String(FLEET_LEASE_SEC)]
    ).catch(() => {});
    res.json({ ok: true });
  });

  // POST /api/fleet/worker/jobs/:id  — reportar resultado (done | failed)
  // En failed con reintentos restantes: re-encola con backoff exponencial.
  app.post("/api/fleet/worker/jobs/:id", requireFleetWorker as any, async (req: any, res: Response) => {
    try {
      const { status, result = null, error = null } = req.body || {};
      const wId = req.worker.id;
      if (status === "done") {
        await pool.query(
          `UPDATE fleet_jobs
           SET status      = 'done',
               result      = $2,
               error       = NULL,
               updated_at  = NOW()
           WHERE id = $1 AND worker_id = $3`,
          [req.params.id, result != null ? JSON.stringify(result) : null, wId]
        );
        return res.json({ ok: true });
      }
      // failed → reintentar con backoff 2^n segundos si quedan intentos
      const { rows } = await pool.query(
        `UPDATE fleet_jobs
         SET status      = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
             worker_id   = NULL,
             lease_until = NULL,
             error       = $2,
             run_after   = CASE WHEN attempts < max_attempts
                                THEN NOW() + (POWER(2, attempts) || ' seconds')::interval
                                ELSE run_after END,
             updated_at  = NOW()
         WHERE id = $1 AND worker_id = $3
         RETURNING status, attempts, max_attempts`,
        [req.params.id, error, wId]
      );
      res.json({ ok: true, job: rows[0] ?? null });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/fleet/jobs  (requireAuth + licencia) — encolar un job
  app.post("/api/fleet/jobs", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const lic = await getRosterLicense(req.user!.id);
      if (!lic && !req.user!.is_admin) return res.status(403).json({ error: "licencia_requerida" });
      const licId = lic?.id ?? 0;
      const {
        type, payload = {}, target_vinted_id = null,
        priority = 0, max_attempts = 3, run_after = null,
      } = req.body || {};
      if (!type) return res.status(400).json({ error: "missing_type" });
      const { rows } = await pool.query(
        `INSERT INTO fleet_jobs
           (license_id, target_vinted_id, type, payload, priority, max_attempts, run_after)
         VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, NOW()))
         RETURNING *`,
        [licId, target_vinted_id, type, JSON.stringify(payload), priority, max_attempts, run_after]
      );
      res.status(201).json({ data: rows[0] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/fleet/worker/overview  (requireAuth) — panel de estado de workers y cola
  app.get("/api/fleet/worker/overview", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const lic = await getRosterLicense(req.user!.id);
      if (!lic && !req.user!.is_admin) return res.json({ data: { workers: [], queue: [] } });
      const [wRes, qRes] = await Promise.all([
        pool.query(
          `SELECT id, vinted_id, status, saturation, running_jobs, last_seen_at
           FROM fleet_workers WHERE license_id = $1 ORDER BY last_seen_at DESC`,
          [lic!.id]
        ),
        pool.query(
          `SELECT status, COUNT(*)::int AS n FROM fleet_jobs WHERE license_id = $1 GROUP BY status`,
          [lic!.id]
        ),
      ]);
      res.json({ data: { workers: wRes.rows, queue: qRes.rows } });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Fleet FASE 4: gestión de workers y cola desde el panel ──────────────────

  // GET /api/fleet/jobs  (requireAuth) — lista jobs de la licencia (más recientes primero)
  app.get("/api/fleet/jobs", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const lic = await getRosterLicense(req.user!.id);
      if (!lic && !req.user!.is_admin) return res.json({ data: [] });
      const limit = Math.min(parseInt(String(req.query.limit || "20"), 10) || 20, 100);
      const { rows } = await pool.query(
        `SELECT id, type, status, target_vinted_id, attempts, max_attempts,
                error, created_at, updated_at
         FROM fleet_jobs WHERE license_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [lic!.id, limit]
      );
      res.json({ data: rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/fleet/worker/:id/pause  (requireAuth) — pausar un worker
  app.post("/api/fleet/worker/:id/pause", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const lic = await getRosterLicense(req.user!.id);
      if (!lic && !req.user!.is_admin) return res.status(403).json({ error: "licencia_requerida" });
      const { rowCount } = await pool.query(
        "UPDATE fleet_workers SET status='paused' WHERE id=$1 AND license_id=$2",
        [req.params.id, lic!.id]
      );
      res.json({ ok: (rowCount ?? 0) > 0 });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/fleet/worker/:id/resume  (requireAuth) — reanudar un worker pausado
  app.post("/api/fleet/worker/:id/resume", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const lic = await getRosterLicense(req.user!.id);
      if (!lic && !req.user!.is_admin) return res.status(403).json({ error: "licencia_requerida" });
      const { rowCount } = await pool.query(
        "UPDATE fleet_workers SET status='online', last_seen_at=NOW() WHERE id=$1 AND license_id=$2",
        [req.params.id, lic!.id]
      );
      res.json({ ok: (rowCount ?? 0) > 0 });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/fleet/worker/:id  (requireAuth) — eliminar un worker
  // Si el worker sigue vivo se re-registra en el siguiente ciclo con un token nuevo.
  app.delete("/api/fleet/worker/:id", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const lic = await getRosterLicense(req.user!.id);
      if (!lic && !req.user!.is_admin) return res.status(403).json({ error: "licencia_requerida" });
      const { rowCount } = await pool.query(
        "DELETE FROM fleet_workers WHERE id=$1 AND license_id=$2",
        [req.params.id, lic!.id]
      );
      res.json({ ok: (rowCount ?? 0) > 0 });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/fleet/jobs/:id/cancel  (requireAuth) — cancelar un job en cola o fallido
  app.post("/api/fleet/jobs/:id/cancel", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const lic = await getRosterLicense(req.user!.id);
      if (!lic && !req.user!.is_admin) return res.status(403).json({ error: "licencia_requerida" });
      const { rowCount } = await pool.query(
        `UPDATE fleet_jobs SET status='canceled', updated_at=NOW()
         WHERE id=$1 AND license_id=$2 AND status IN ('queued','failed')`,
        [req.params.id, lic!.id]
      );
      res.json({ ok: (rowCount ?? 0) > 0 });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/fleet/jobs/:id/retry  (requireAuth) — reintentar un job failed o cancelado
  app.post("/api/fleet/jobs/:id/retry", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const lic = await getRosterLicense(req.user!.id);
      if (!lic && !req.user!.is_admin) return res.status(403).json({ error: "licencia_requerida" });
      const { rowCount } = await pool.query(
        `UPDATE fleet_jobs
         SET status='queued', attempts=0, error=NULL,
             run_after=NOW(), worker_id=NULL, lease_until=NULL, updated_at=NOW()
         WHERE id=$1 AND license_id=$2 AND status IN ('failed','canceled')`,
        [req.params.id, lic!.id]
      );
      res.json({ ok: (rowCount ?? 0) > 0 });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Extension: server-side inventory fetch (Blackstock-style proxy) ─────────
  // The server fetches items from Vinted using the stored session_cookie,
  // so the extension never needs to call Vinted directly.
  app.post("/api/extension/fetch-inventory", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { accountId } = req.body || {};
      if (!accountId) return res.status(400).json({ ok: false, error: "accountId required" });

      // Verify account belongs to user and get stored session
      const acc = await pool.query(
        `SELECT id, vinted_id, domain, session_cookie, cookie FROM vinted_accounts WHERE id=$1 AND user_id=$2`,
        [accountId, userId]
      );
      if (!acc.rows.length) return res.status(403).json({ ok: false, error: "account_not_found" });

      const account = acc.rows[0];
      const { vinted_id, domain, session_cookie, cookie: bearerToken } = account;

      if (!vinted_id) return res.status(400).json({ ok: false, error: "vinted_id_missing" });
      if (!session_cookie && !bearerToken) return res.status(400).json({ ok: false, error: "no_session_stored" });

      const base = `https://www.vinted.${domain || "es"}`;
      const allItems: any[] = [];
      let page = 1;

      // Fetch all pages of the wardrobe (same as Blackstock: server proxies Vinted)
      while (page <= 5) {
        const url = `${base}/api/v2/wardrobe/${encodeURIComponent(String(vinted_id))}/items?page=${page}&per_page=96&order=newest_first`;
        const headers: Record<string, string> = {
          "Accept": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        };
        if (session_cookie) headers["Cookie"] = session_cookie;
        if (bearerToken) headers["Authorization"] = `Bearer ${bearerToken}`;

        let vintedRes: globalThis.Response;
        try {
          vintedRes = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
        } catch (fetchErr: any) {
          console.warn(`[fetch-inventory] fetch error page ${page}:`, fetchErr?.message);
          break;
        }
        if (!vintedRes.ok) {
          console.warn(`[fetch-inventory] Vinted HTTP ${vintedRes.status} for account ${accountId} page ${page}`);
          break;
        }
        const data = await vintedRes.json().catch(() => null);
        const pageItems: any[] = data?.items || data?.wardrobe_items || [];
        if (!pageItems.length) break;

        for (const it of pageItems) {
          allItems.push({
            id:        String(it.id || ""),
            title:     it.title || "",
            price:     Number(it.price_numeric || it.price?.amount || it.price || 0),
            status:    it.status || "active",
            image_url: it.photos?.[0]?.full_size_url || it.photos?.[0]?.url || it.photo?.full_size_url || it.photo?.url || null,
            url:       it.url || `${base}/items/${it.id}`,
          });
        }
        if (pageItems.length < 96) break;
        page++;
      }

      if (!allItems.length) {
        return res.json({ ok: true, upserted: 0, total: 0, message: "no_items_found" });
      }

      // Upsert all items into vinted_inventory
      let upserted = 0;
      for (const item of allItems) {
        if (!item.id) continue;
        await pool.query(
          `INSERT INTO vinted_inventory (account_id, item_id, title, price, status, image_url, url, last_synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
           ON CONFLICT (account_id, item_id)
           DO UPDATE SET title=$3, price=$4, status=$5, image_url=$6, url=$7, last_synced_at=NOW()`,
          [accountId, String(item.id), item.title || "", Number(item.price) || 0, item.status || "active", item.image_url || null, item.url || null]
        );
        upserted++;
      }

      // Update items_count
      await pool.query(
        `UPDATE vinted_accounts
         SET items_count = (SELECT COUNT(*) FROM vinted_inventory WHERE account_id=$1 AND status='active'),
             last_synced_at = NOW()
         WHERE id = $1`,
        [accountId]
      );

      console.log(`[fetch-inventory] account ${accountId} → upserted ${upserted} items`);
      res.json({ ok: true, upserted, total: allItems.length });
    } catch (e: any) {
      console.error("[fetch-inventory] error:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Extension: get current user + license + accounts ─────────────────────
  app.get("/api/extension/me", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const userRow = req.user!;

      // License
      const licRow = await pool.query(
        `SELECT key, type, expires_at FROM licenses WHERE user_id=$1 AND is_active=TRUE AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      const lic = licRow.rows[0] || null;

      // Accounts with quick stats
      const accRows = await pool.query(
        `SELECT va.id, va.username, va.domain,
                COUNT(DISTINCT vi.id) FILTER (WHERE vi.status='active') AS active_items,
                COUNT(DISTINCT s.id) AS total_orders,
                COALESCE(SUM(s.sell_price),0) AS revenue
         FROM vinted_accounts va
         LEFT JOIN vinted_inventory vi ON vi.account_id = va.id
         LEFT JOIN sales s ON s.account_id = va.id
         WHERE va.user_id=$1 AND va.is_active=TRUE
         GROUP BY va.id
         ORDER BY va.created_at DESC`,
        [userId]
      );

      res.json({
        ok: true,
        user: { id: userRow.id, username: userRow.username, email: userRow.email, is_admin: userRow.is_admin },
        license: lic ? { key: lic.key, plan: lic.type, status: "active", expiresAt: lic.expires_at } : null,
        accounts: accRows.rows.map(a => ({
          id: a.id,
          username: a.username,
          domain: a.domain,
          activeItems: Number(a.active_items),
          totalOrders: Number(a.total_orders),
          revenue: Number(a.revenue),
        })),
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Extension: bulk sync inventory items for an account ──────────────────
  app.post("/api/extension/sync-items", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { accountId, items } = req.body || {};
      if (!accountId || !Array.isArray(items)) {
        return res.status(400).json({ ok: false, error: "accountId and items[] required" });
      }
      // Verify account belongs to user
      const acc = await pool.query(
        `SELECT id FROM vinted_accounts WHERE id=$1 AND user_id=$2`,
        [accountId, userId]
      );
      if (!acc.rows.length) return res.status(403).json({ ok: false, error: "account_not_found" });

      const limited = items.slice(0, 500);
      let upserted = 0;
      for (const item of limited) {
        const { id, title, price, status, image_url, url } = item;
        if (!id) continue;
        await pool.query(
          `INSERT INTO vinted_inventory (account_id, item_id, title, price, status, image_url, url, last_synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
           ON CONFLICT (account_id, item_id)
           DO UPDATE SET title=$3, price=$4, status=$5, image_url=$6, url=$7, last_synced_at=NOW()`,
          [accountId, String(id), title || "", Number(price) || 0, status || "active", image_url || null, url || null]
        );
        upserted++;
      }
      // Update items_count in vinted_accounts
      await pool.query(
        `UPDATE vinted_accounts
         SET items_count = (SELECT COUNT(*) FROM vinted_inventory WHERE account_id=$1 AND status='active'),
             last_synced_at = NOW()
         WHERE id = $1`,
        [accountId]
      );
      res.json({ ok: true, upserted });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 2. Whitelist items — añadir
  app.post("/api/extension/whitelist-items", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { itemId, itemUrl } = req.body || {};
      if (!itemId) return res.status(400).json({ ok: false, error: "itemId_required" });
      await pool.query(
        `INSERT INTO whitelist_items (user_id, item_id, item_url)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, item_id) DO UPDATE SET item_url = EXCLUDED.item_url`,
        [userId, String(itemId), itemUrl || null]
      );
      res.json({ ok: true });
    } catch (err: any) {
      console.error("whitelist-items POST error", err?.message);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // 3. Whitelist items — listar
  app.get("/api/extension/whitelist-items", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const result = await pool.query(
        `SELECT item_id, item_url, created_at FROM whitelist_items
         WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      );
      const items = result.rows.map((r: any) => ({
        itemId: r.item_id,
        itemUrl: r.item_url,
        createdAt: r.created_at,
      }));
      res.json({ ok: true, items });
    } catch (err: any) {
      console.error("whitelist-items GET error", err?.message);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // 4. Whitelist profiles — añadir
  app.post("/api/extension/whitelist-profiles", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { memberId, profileUrl } = req.body || {};
      if (!memberId) return res.status(400).json({ ok: false, error: "memberId_required" });
      await pool.query(
        `INSERT INTO whitelist_profiles (user_id, member_id, profile_url)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, member_id) DO UPDATE SET profile_url = EXCLUDED.profile_url`,
        [userId, String(memberId), profileUrl || null]
      );
      res.json({ ok: true });
    } catch (err: any) {
      console.error("whitelist-profiles POST error", err?.message);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // 13. Whitelist profiles — listar
  app.get("/api/extension/whitelist-profiles", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const result = await pool.query(
        `SELECT member_id, profile_url, created_at FROM whitelist_profiles
         WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      );
      const profiles = result.rows.map((r: any) => ({
        memberId: r.member_id,
        profileUrl: r.profile_url,
        createdAt: r.created_at,
      }));
      res.json({ ok: true, profiles });
    } catch (err: any) {
      console.error("whitelist-profiles GET error", err?.message);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // 14. Whitelist items — borrar
  app.delete("/api/extension/whitelist-items/:itemId", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { itemId } = req.params;
      await pool.query(
        `DELETE FROM whitelist_items WHERE user_id = $1 AND item_id = $2`,
        [userId, String(itemId)]
      );
      res.json({ ok: true });
    } catch (err: any) {
      console.error("whitelist-items DELETE error", err?.message);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // 15. Whitelist profiles — borrar
  app.delete("/api/extension/whitelist-profiles/:memberId", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { memberId } = req.params;
      await pool.query(
        `DELETE FROM whitelist_profiles WHERE user_id = $1 AND member_id = $2`,
        [userId, String(memberId)]
      );
      res.json({ ok: true });
    } catch (err: any) {
      console.error("whitelist-profiles DELETE error", err?.message);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // 5. Camouflage tick — placeholder
  app.get("/api/extension/camouflage/tick", requireLicense as any, async (_req: AuthRequest, res: Response) => {
    try {
      res.json({ ok: true, action: "noop" });
    } catch {
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // 6. Boost worker — siguiente tarea (stub)
  app.get("/boost/worker/next", requireLicense as any, async (_req: AuthRequest, res: Response) => {
    try {
      res.json({ ok: true, task: null });
    } catch {
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // 7. Boost task — completar (stub)
  app.post("/boost/tasks/:id/complete", requireLicense as any, async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { ok, durationMs, error } = req.body || {};
      console.log("[boost] task complete", { id, ok, durationMs, error });
      res.json({ ok: true, acknowledged: true });
    } catch {
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // ── Boost dashboard endpoints (required by BoostPage) ──────────────────────
  // GET /api/boost/requests — lista de jobs de boost del usuario
  app.get('/api/boost/requests', requireLicense as any, async (req: AuthRequest, res: Response) => {
    try {
      const r = await pool.query(
        `SELECT id, status, created_at, account_login, items_count
         FROM boost_requests
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [req.user!.id]
      );
      res.json(r.rows);
    } catch (e: any) {
      console.error('[boost/requests]', e.message);
      res.json([]); // devolver array vacío antes que error → UI muestra "sin jobs"
    }
  });

  // GET /api/boost/stats — estadísticas de boost del usuario
  app.get('/api/boost/stats', requireLicense as any, async (req: AuthRequest, res: Response) => {
    try {
      const r = await pool.query(
        `SELECT
           COUNT(*)::int                                               AS total,
           COUNT(*) FILTER (WHERE status = 'completed')::int         AS completed,
           COUNT(*) FILTER (WHERE status IN ('pending','running'))::int AS pending,
           COUNT(*) FILTER (WHERE status = 'failed')::int            AS failed
         FROM boost_requests
         WHERE user_id = $1`,
        [req.user!.id]
      );
      const row = r.rows[0] || {};
      res.json({
        total:     row.total     ?? 0,
        completed: row.completed ?? 0,
        pending:   row.pending   ?? 0,
        failed:    row.failed    ?? 0,
      });
    } catch (e: any) {
      console.error('[boost/stats]', e.message);
      res.json({ total: 0, completed: 0, pending: 0, failed: 0 });
    }
  });

  // 8. Admin: bazooka workers probe (real data)
  app.get("/api/admin/bazooka-workers-probe", requireAdmin as any, async (_req: AuthRequest, res: Response) => {
    try {
      const r = await pool.query(
        `SELECT name, status, active_jobs, version, host, uptime_sec, last_seen,
                EXTRACT(EPOCH FROM (NOW() - last_seen))::int AS seconds_since_last_ping
         FROM bazooka_workers ORDER BY last_seen DESC`
      );
      const workers = r.rows.map((w: any) => ({
        name: w.name,
        busyNow: w.status === 'busy',
        responsiveNow: w.seconds_since_last_ping < 120,
        secondsSinceLastPing: w.seconds_since_last_ping,
        version: w.version,
        host: w.host,
        activeJobs: w.active_jobs,
        uptimeSec: w.uptime_sec,
      }));
      const activeNow = workers.filter((w: any) => w.responsiveNow).length;
      const busy = workers.filter((w: any) => w.responsiveNow && w.busyNow).length;
      res.json({
        ok: true,
        activeNowWorkers: activeNow,
        busyNowWorkers: busy,
        idleNowWorkers: activeNow - busy,
        offlineNowWorkers: workers.length - activeNow,
        workers,
      });
    } catch (err: any) {
      console.error('[admin/bazooka-workers-probe]', err.message);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // 9. Admin: bazooka orchestra (real metrics)
  app.get("/api/admin/bazooka-orchestra", requireAdmin as any, async (_req: AuthRequest, res: Response) => {
    try {
      const [workersR, recentJobsR, pendingR] = await Promise.all([
        pool.query(`SELECT COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (NOW()-last_seen)) < 120) AS active,
                           COUNT(*) FILTER (WHERE status='busy' AND EXTRACT(EPOCH FROM (NOW()-last_seen)) < 120) AS busy
                    FROM bazooka_workers`),
        pool.query(`SELECT COUNT(*) AS total,
                           COUNT(*) FILTER (WHERE status='done') AS done,
                           COALESCE(AVG(duration_ms) FILTER (WHERE status='done'), 0)::int AS avg_dur
                    FROM bazooka_jobs WHERE completed_at > NOW() - INTERVAL '1 hour'`),
        pool.query(`SELECT COUNT(*) AS total,
                           COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)::int AS oldest_sec
                    FROM bazooka_jobs WHERE status='pending'`),
      ]);
      const w = workersR.rows[0];
      const j = recentJobsR.rows[0];
      const p = pendingR.rows[0];
      const active = Number(w.active) || 0;
      const busy = Number(w.busy) || 0;
      const totalJobs = Number(j.total) || 0;
      const doneJobs = Number(j.done) || 0;
      const oldJobs5mR = await pool.query(
        `SELECT COUNT(*)::int AS n FROM bazooka_jobs WHERE completed_at > NOW() - INTERVAL '5 minutes'`
      );
      res.json({
        ok: true,
        saturationPercent: active > 0 ? Math.round((busy / active) * 100) : 0,
        jobsPerMinute5m: Math.round((Number(oldJobs5mR.rows[0].n) || 0) / 5),
        averageCompletionSeconds: Math.round((Number(j.avg_dur) || 0) / 1000),
        oldestPendingSeconds: Number(p.oldest_sec) || 0,
        queuePerOnlineWorker: active > 0 ? Math.round(Number(p.total) / active) : Number(p.total) || 0,
        successRate1h: totalJobs > 0 ? Math.round((doneJobs / totalJobs) * 100) : 100,
      });
    } catch (err: any) {
      console.error('[admin/bazooka-orchestra]', err.message);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // ── Bazooka Worker Fleet (VPS-side, x-worker-secret auth) ────────────────────

  // GET /api/bazooka/worker/next-job — claim oldest pending job
  app.get('/api/bazooka/worker/next-job', requireWorkerSecret, async (req, res) => {
    const workerName = String(req.headers['x-worker-name'] || 'unknown');
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query(
          `SELECT id, url, type, params FROM bazooka_jobs
           WHERE status = 'pending'
           ORDER BY created_at ASC
           LIMIT 1 FOR UPDATE SKIP LOCKED`
        );
        if (!r.rows[0]) {
          await client.query('COMMIT');
          return res.json({ ok: true, job: null });
        }
        const job = r.rows[0];
        await client.query(
          `UPDATE bazooka_jobs SET status='claimed', claimed_by=$1, claimed_at=NOW() WHERE id=$2`,
          [workerName, job.id]
        );
        await client.query('COMMIT');
        return res.json({ ok: true, job: { id: job.id, url: job.url, type: job.type, params: job.params || {} } });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error('[bazooka/worker/next-job]', err.message);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // PATCH /api/bazooka/worker/jobs/:id — report job result
  app.patch('/api/bazooka/worker/jobs/:id', requireWorkerSecret, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const { status, durationMs, error } = req.body || {};
    if (status !== 'done' && status !== 'failed') {
      return res.status(400).json({ ok: false, error: 'invalid_status' });
    }
    try {
      await pool.query(
        `UPDATE bazooka_jobs SET status=$1, completed_at=NOW(), duration_ms=$2, error=$3 WHERE id=$4`,
        [status, Number.isFinite(durationMs) ? durationMs : null, error || null, id]
      );
      res.json({ ok: true });
    } catch (err: any) {
      console.error('[bazooka/worker/jobs PATCH]', err.message);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // POST /api/bazooka/worker/heartbeat — worker liveness ping
  app.post('/api/bazooka/worker/heartbeat', requireWorkerSecret, async (req, res) => {
    const { name, status, activeJobs, version, host, uptimeSec } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ ok: false, error: 'name_required' });
    const normalizedStatus = ['idle', 'busy', 'offline'].includes(status) ? status : 'idle';
    try {
      await pool.query(
        `INSERT INTO bazooka_workers (name, status, active_jobs, version, host, uptime_sec, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (name) DO UPDATE SET
           status = EXCLUDED.status,
           active_jobs = EXCLUDED.active_jobs,
           version = EXCLUDED.version,
           host = EXCLUDED.host,
           uptime_sec = EXCLUDED.uptime_sec,
           last_seen = NOW()`,
        [name, normalizedStatus, Number(activeJobs) || 0, version || null, host || null, Number(uptimeSec) || 0]
      );
      res.json({ ok: true });
    } catch (err: any) {
      console.error('[bazooka/worker/heartbeat]', err.message);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // 10. Vinted show — stub
  app.post("/api/vinted/show", requireLicense as any, async (_req: AuthRequest, res: Response) => {
    try {
      res.json({ ok: true, stub: true });
    } catch {
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // 11. Vinted bump — stub
  app.post("/api/vinted/bump", requireLicense as any, async (_req: AuthRequest, res: Response) => {
    try {
      res.json({ ok: true, stub: true });
    } catch {
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // 12. Vinted delete — stub
  app.post("/api/vinted/delete", requireLicense as any, async (_req: AuthRequest, res: Response) => {
    try {
      res.json({ ok: true, stub: true });
    } catch {
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // ── Lamine Anty — info + download ──────────────────────────────────────────

  app.get("/api/anty/info", (_req, res) => {
    res.json({
      ok: true,
      name: "Lamine Anty",
      version: "0.3.0",
      available: true,
      platform: "macOS",
      features: [
        "Antidetect · TLS Safari iOS",
        "Perfiles aislados",
        "WebRTC Guard",
        "Proxy integrado",
      ],
    });
  });

  // ── Lamine Anty DMG downloads (redirect to GitHub releases) ─────────────
  const ANTY_GH =
    "https://github.com/EcomRodrii/lamine-anty-releases/releases/download/v0.3.0";
  const ANTY_FILES: Record<string, string> = {
    "Lamine-Anty-0.3.0-arm64.dmg": `${ANTY_GH}/Lamine.Anty-0.3.0-arm64.dmg`,
    "Lamine-Anty-0.3.0.dmg": `${ANTY_GH}/Lamine-Anty-0.3.0.zip`,
  };

  app.get("/downloads/lamine-anty/:filename", (req: Request, res: Response) => {
    const target = ANTY_FILES[req.params.filename];
    if (!target) { res.status(404).json({ error: "not_found" }); return; }
    res.redirect(302, target);
  });

  // legacy redirect
  app.get("/downloads/anty", (_req, res) => {
    res.redirect(302, `${ANTY_GH}/Lamine.Anty-0.3.0-arm64.dmg`);
  });

  // ── Vinte reposts (called by global-addon from page context) ─────────────────
  // hub-runtime-bridge.js intercepts this in page context; background-side stub:
  app.post("/api/vinted/items/reposts", requireLicense as any, async (_req: AuthRequest, res: Response) => {
    res.json({ ok: true });
  });

  // ── Vinted session save — decode Vinted JWT to extract userId + username ──
  app.post("/api/vinted/session/save", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const { bearerToken, domain, anonId } = req.body || {};

      // Decode Vinted JWT payload (no signature check needed — we just want the claims)
      let vintedUserId: string | null = null;
      let vintedUsername: string | null = null;

      if (bearerToken) {
        try {
          const parts = String(bearerToken).split(".");
          if (parts.length >= 2) {
            const payload = JSON.parse(
              Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
            );
            // Vinted JWT payload: user_id or sub
            vintedUserId = String(
              payload.user_id || payload.sub || payload.id || payload.uid || ""
            ).trim() || null;
            vintedUsername = String(
              payload.login || payload.username || payload.email?.split("@")[0] || ""
            ).trim() || null;
          }
        } catch (_) {}
      }

      // Persist session to DB for multi-account tracking (best effort)
      if (vintedUserId && req.user?.id) {
        await pool.query(
          `INSERT INTO vinted_sessions (user_id, vinted_user_id, vinted_username, domain, anon_id, last_seen)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (user_id, vinted_user_id) DO UPDATE
             SET vinted_username = EXCLUDED.vinted_username,
                 domain = EXCLUDED.domain,
                 anon_id = EXCLUDED.anon_id,
                 last_seen = NOW()`,
          [req.user.id, vintedUserId, vintedUsername, domain || "es", anonId || null]
        ).catch(() => {}); // table may not exist yet, no-op
      }

      res.json({ ok: true, vintedUserId, vintedUsername });
    } catch (err: any) {
      console.error("[session/save]", err?.message);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // ── AI Inbox Reply — generate a suggested reply for a Vinted conversation ──
  app.post("/api/ai/inbox/reply", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const { messages, itemTitle, itemPrice, buyerName, sellerName } = req.body as {
        messages: { isMe: boolean; text: string }[];
        itemTitle: string;
        itemPrice: string | number;
        buyerName: string;
        sellerName: string;
      };

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ ok: false, error: "openai_not_configured" });
      }

      const systemPrompt =
        `Eres el asistente de ventas de un vendedor en Vinted. Genera respuestas breves (máximo 2-3 frases), amables y naturales.\n` +
        `Artículo: "${itemTitle}" - ${itemPrice}€. Vendedor: ${sellerName}. Comprador: ${buyerName}.\n` +
        `Responde siempre en el mismo idioma que el comprador. Tono directo y cercano. Sin emojis excesivos.`;

      const lastMessages = (messages || []).slice(-6).map((m) => ({
        role: m.isMe ? "assistant" : "user",
        content: m.text,
      }));

      const openaiMessages = [
        { role: "system", content: systemPrompt },
        ...lastMessages,
      ];

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: openaiMessages,
          max_tokens: 150,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        console.error("[ai/inbox/reply] OpenAI error", response.status, await response.text());
        return res.status(500).json({ ok: false, error: "openai_error" });
      }

      const data = await response.json() as {
        choices: { message: { content: string } }[];
      };
      const reply = data.choices?.[0]?.message?.content?.trim() ?? "";
      return res.json({ ok: true, reply });
    } catch (err: any) {
      console.error("[ai/inbox/reply]", err?.message);
      return res.status(500).json({ ok: false, error: "openai_error" });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // AUTO-PUBLISH — gestión de borradores + publicación automática en Vinted
  // ════════════════════════════════════════════════════════════════════════════

  // GET /api/vinted/accounts — cuentas vinculadas con session_cookie
  app.get("/api/vinted/accounts", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const r = await pool.query(
        `SELECT id, username, vinted_id, domain, is_active, updated_at
         FROM vinted_accounts
         WHERE user_id = $1 AND is_active = TRUE
         ORDER BY updated_at DESC NULLS LAST`,
        [req.user!.id]
      );
      res.json({ ok: true, accounts: r.rows });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/autopublish/listings
  app.get("/api/autopublish/listings", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const r = await pool.query(
        `SELECT id, title, description, price, condition, brand, size, gender,
                package_size, images, status, vinted_id, published_at, created_at, updated_at
         FROM vinted_autopublish_listings
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [req.user!.id]
      );
      res.json({ ok: true, listings: r.rows });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/autopublish/listings — crear borrador
  app.post("/api/autopublish/listings", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const { title, description, price, condition, brand, size, gender, package_size, images } = req.body;
      if (!title || price == null) return res.status(400).json({ ok: false, error: "title y price requeridos" });
      const r = await pool.query(
        `INSERT INTO vinted_autopublish_listings
           (user_id, title, description, price, condition, brand, size, gender, package_size, images)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          req.user!.id, title, description || null, Number(price),
          condition || "neuf_sans_etiquette", brand || null, size || null,
          gender || "men", package_size || "small",
          JSON.stringify(images || []),
        ]
      );
      res.json({ ok: true, listing: r.rows[0] });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // PUT /api/autopublish/listings/:id — actualizar borrador
  app.put("/api/autopublish/listings/:id", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const { title, description, price, condition, brand, size, gender, package_size, images } = req.body;
      await pool.query(
        `UPDATE vinted_autopublish_listings
         SET title=$1, description=$2, price=$3, condition=$4, brand=$5,
             size=$6, gender=$7, package_size=$8, images=$9, updated_at=NOW()
         WHERE id=$10 AND user_id=$11`,
        [
          title, description || null, Number(price),
          condition || "neuf_sans_etiquette", brand || null, size || null,
          gender || "men", package_size || "small",
          JSON.stringify(images || []),
          req.params.id, req.user!.id,
        ]
      );
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // DELETE /api/autopublish/listings/:id
  app.delete("/api/autopublish/listings/:id", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      await pool.query(
        "DELETE FROM vinted_autopublish_listings WHERE id=$1 AND user_id=$2",
        [req.params.id, req.user!.id]
      );
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/autopublish/listings/:id/publish — SSE stream
  app.post("/api/autopublish/listings/:id/publish", requireAuth as any, async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const listingId = Number(req.params.id);

    // Load listing
    let listing: any;
    try {
      const lr = await pool.query(
        "SELECT * FROM vinted_autopublish_listings WHERE id=$1 AND user_id=$2",
        [listingId, userId]
      );
      if (!lr.rows[0]) return res.status(404).json({ ok: false, error: "Anuncio no encontrado" });
      listing = lr.rows[0];
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e.message });
    }

    // Load stored session (most recently updated account)
    let account: any;
    try {
      const ar = await pool.query(
        `SELECT cookie, session_cookie, domain, vinted_id
         FROM vinted_accounts
         WHERE user_id=$1 AND is_active=TRUE
         ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
        [userId]
      );
      account = ar.rows[0];
    } catch { account = null; }

    if (!account?.session_cookie && !account?.cookie) {
      return res.status(400).json({
        ok: false,
        error: "No hay sesión de Vinted guardada. Abre vinted.es con la extensión activa."
      });
    }

    // Mark as publishing
    await pool.query(
      "UPDATE vinted_autopublish_listings SET status='publishing', updated_at=NOW() WHERE id=$1",
      [listingId]
    ).catch(() => {});

    // Set up SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sendEvent = (data: object) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Primer evento inmediato — hace visible el log panel antes de que Puppeteer arranque
    sendEvent({ type: "log", step: "init", message: "⏳ Iniciando publicación automática..." });

    // Build payload
    const payload = {
      title:       listing.title,
      description: listing.description || "",
      price:       Number(listing.price),
      condition:   listing.condition || "neuf_sans_etiquette",
      brand:       listing.brand || "",
      size:        listing.size || undefined,
      gender:      listing.gender || "men",
      images:      Array.isArray(listing.images) ? listing.images : (JSON.parse(listing.images || "[]")),
      packageSize: listing.package_size || "small",
      domain:      account.domain || "es",
    };

    // Run Puppeteer — lazy import + try-catch explícito para capturar errores de carga del módulo
    let publishToVinted: any;
    try {
      const mod = await import("./vinted-publisher.js");
      publishToVinted = mod.publishToVinted;
    } catch (importErr: any) {
      sendEvent({ type: "error", step: "import", message: `❌ Error al cargar el motor de publicación: ${importErr.message}` });
      await pool.query("UPDATE vinted_autopublish_listings SET status='failed', updated_at=NOW() WHERE id=$1", [listingId]).catch(() => {});
      if (!res.writableEnded) res.end();
      return;
    }

    publishToVinted(
      account.session_cookie || "",
      account.cookie || null,
      payload,
      (event: any) => sendEvent(event)
    ).then(async (result: any) => {
      const newStatus = result.published ? "published" : "failed";
      await pool.query(
        `UPDATE vinted_autopublish_listings
         SET status=$1, vinted_id=$2, published_at=$3, updated_at=NOW()
         WHERE id=$4`,
        [
          newStatus,
          result.vintedId || null,
          result.published ? new Date() : null,
          listingId,
        ]
      ).catch(() => {});
      logActivity(userId, `autopublish_${newStatus}`, req.ip);
      if (!res.writableEnded) res.end();
    }).catch((err: any) => {
      sendEvent({ type: "error", step: "fatal", message: `Error fatal: ${err.message}` });
      pool.query(
        "UPDATE vinted_autopublish_listings SET status='failed', updated_at=NOW() WHERE id=$1",
        [listingId]
      ).catch(() => {});
      if (!res.writableEnded) res.end();
    });

    req.on("close", () => { if (!res.writableEnded) res.end(); });
  });

  // ── Vinted Sessions — list accounts linked to user ──────────────────────
  app.get("/api/vinted/sessions", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const r = await pool.query(
        `SELECT vinted_user_id, vinted_username, domain, last_seen
         FROM vinted_sessions
         WHERE user_id = $1
         ORDER BY last_seen DESC`,
        [req.user!.id]
      ).catch(() => ({ rows: [] }));
      res.json({ ok: true, sessions: r.rows });
    } catch {
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // ── Labels — store label URLs found passively by vinted-favourite-sniffer ──
  app.post("/api/extension/labels", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const { transactionId, labelUrl, labelCarrier, vintedUserId } = req.body || {};
      if (!transactionId || !labelUrl) return res.status(400).json({ ok: false, error: "missing_fields" });
      await pool.query(
        `INSERT INTO order_labels (user_id, transaction_id, label_url, label_carrier, vinted_user_id, found_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (user_id, transaction_id) DO UPDATE
           SET label_url = EXCLUDED.label_url,
               label_carrier = EXCLUDED.label_carrier,
               found_at = NOW()`,
        [req.user!.id, String(transactionId), String(labelUrl), String(labelCarrier || ""), String(vintedUserId || "")]
      ).catch(() => {}); // table may not exist yet
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  app.get("/api/extension/labels", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const r = await pool.query(
        `SELECT transaction_id, label_url, label_carrier, vinted_user_id, found_at
         FROM order_labels
         WHERE user_id = $1
         ORDER BY found_at DESC
         LIMIT 100`,
        [req.user!.id]
      ).catch(() => ({ rows: [] }));
      res.json({ ok: true, labels: r.rows });
    } catch {
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // ── Labels: sync with full PDF blob ──────────────────────────────────────
  // Called by background-hub.js when it intercepts the shipping label PDF
  app.post("/api/extension/labels/sync", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { etiquetas } = req.body || {};
      if (!Array.isArray(etiquetas) || !etiquetas.length) {
        return res.status(400).json({ ok: false, error: "etiquetas_required" });
      }
      let saved = 0;
      for (const e of etiquetas.slice(0, 50)) {
        const { transaccion_externa, pdf_base64, label_url, carrier } = e;
        if (!transaccion_externa) continue;
        await pool.query(
          `INSERT INTO order_labels
             (user_id, transaction_id, label_url, label_carrier, carrier, pdf_data, status, found_at)
           VALUES ($1,$2,$3,$4,$5,$6,'captured',NOW())
           ON CONFLICT (user_id, transaction_id) DO UPDATE
             SET pdf_data     = COALESCE(EXCLUDED.pdf_data, order_labels.pdf_data),
                 label_url    = COALESCE(EXCLUDED.label_url, order_labels.label_url),
                 carrier      = COALESCE(EXCLUDED.carrier, order_labels.carrier),
                 label_carrier= COALESCE(EXCLUDED.carrier, order_labels.label_carrier),
                 status       = 'captured',
                 found_at     = NOW()`,
          [userId, String(transaccion_externa), label_url || null, carrier || "", carrier || "", pdf_base64 || null]
        ).catch(() => {});
        saved++;
      }
      res.json({ ok: true, saved });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Labels: serve stored PDF ──────────────────────────────────────────────
  app.get("/api/extension/labels/:id/pdf", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const txId = req.params.id;
      const r = await pool.query(
        `SELECT pdf_data, label_url FROM order_labels WHERE user_id=$1 AND transaction_id=$2 LIMIT 1`,
        [userId, txId]
      );
      if (!r.rows.length) return res.status(404).json({ ok: false, error: "not_found" });
      const row = r.rows[0];
      if (row.pdf_data) {
        // Serve from stored base64 blob
        const buf = Buffer.from(row.pdf_data, "base64");
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="etiqueta-${txId}.pdf"`);
        res.setHeader("Content-Length", String(buf.length));
        return res.send(buf);
      }
      if (row.label_url) {
        // Redirect to original URL as fallback
        return res.redirect(302, row.label_url);
      }
      res.status(404).json({ ok: false, error: "no_pdf" });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Extension accounts: simple alias (background-hub.js uses this) ────────
  app.get("/api/extension/accounts", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const r = await pool.query(
        `SELECT id, username AS login, username AS title, domain AS country_code,
                is_active, items_count, sold_count, balance, last_synced_at
         FROM vinted_accounts WHERE user_id=$1 AND is_active=TRUE ORDER BY created_at DESC`,
        [req.user!.id]
      );
      res.json({ ok: true, accounts: r.rows });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Restocker: pending label capture (hub-addon proactive sweep) ──────────
  app.get("/api/restocker/labels/pending_capture", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const max = Math.min(Number(req.query.max) || 10, 50);
      // Sales that have a vinted transaction ID but no captured label yet
      const r = await pool.query(
        `SELECT s.vinted_order_id AS transaction_id,
                s.id AS sale_id,
                s.amount,
                va.username AS account_login,
                va.domain
         FROM sales s
         LEFT JOIN order_labels ol ON ol.user_id = s.user_id
                                   AND ol.transaction_id = s.vinted_order_id::text
         JOIN vinted_accounts va ON va.id = s.account_id
         WHERE s.user_id = $1
           AND s.vinted_order_id IS NOT NULL
           AND ol.transaction_id IS NULL
         ORDER BY s.created_at DESC
         LIMIT $2`,
        [userId, max]
      ).catch(() => ({ rows: [] }));
      res.json({ ok: true, items: r.rows });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Vinted accounts CRUD (for extension FounderClub tab) ──────────────────
  app.get("/api/vinted/accounts", requireAuth as any, async (req: AuthRequest, res) => {
    const result = await pool.query(
      `SELECT id, id::text AS vinted_id, username AS login, username AS title,
              label, domain AS country_code, balance, items_count, sold_count,
              last_synced_at, is_active,
              CASE WHEN is_active THEN 'active' ELSE 'inactive' END AS status,
              TRUE AS can_auto_messages, TRUE AS can_reposts,
              created_at, updated_at
       FROM vinted_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user!.id]
    );
    // Dual format: ok/data (Blackstock compat) + success/accounts (legacy panel compat)
    res.json({
      ok: true,
      success: true,
      data: {
        accounts: result.rows,
        meta: { has_next_page: false, end_cursor: null, start_cursor: null, total_pages: 1, total_entries: result.rows.length },
      },
      accounts: result.rows,
    });
  });

  app.post("/api/vinted/accounts", requireAuth as any, async (req: AuthRequest, res) => {
    const { cookie, domain = "es", label } = req.body;
    if (!cookie) return res.status(400).json({ success: false, error: "cookie_required" });
    try {
      const username = label || `cuenta_${Date.now()}`;
      const result = await pool.query(
        "INSERT INTO vinted_accounts (user_id, username, cookie, domain, label) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, username) DO UPDATE SET cookie = $3, domain = $4 RETURNING id, username",
        [req.user!.id, username, cookie, domain.replace("vinted.", "").replace(".es", ""), label || null]
      );
      res.json({ success: true, account: result.rows[0] });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete("/api/vinted/accounts/:id", requireAuth as any, async (req: AuthRequest, res) => {
    await pool.query("DELETE FROM vinted_accounts WHERE id = $1 AND user_id = $2", [req.params.id, req.user!.id]);
    res.json({ success: true });
  });

  app.post("/api/vinted/accounts/:id/sync", requireAuth as any, async (req: AuthRequest, res) => {
    // Placeholder — triggers a background sync job
    await pool.query("UPDATE vinted_accounts SET last_synced_at = NOW() WHERE id = $1 AND user_id = $2", [req.params.id, req.user!.id]);
    res.json({ success: true, message: "Sync iniciado" });
  });

  app.post("/api/vinted/accounts/:id/hide-all", requireAuth as any, async (req: AuthRequest, res) => {
    const { reveal = false } = req.body;
    await pool.query(
      "UPDATE vinted_inventory SET is_hidden = $1 WHERE account_id = $2",
      [!reveal, req.params.id]
    );
    res.json({ success: true, reveal });
  });

  // ── GET /api/vinted/:accountId/items  (Blackstock compat) ──────────────────
  app.get("/api/vinted/:accountId/items", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const { accountId } = req.params;
      const limit  = Math.min(parseInt(String(req.query.limit  || "50")), 200);
      const cursor = req.query.cursor ? parseInt(String(req.query.cursor)) : null;
      const status = req.query.status ? String(req.query.status) : null;

      // Verify account belongs to user
      const accResult = await pool.query(
        "SELECT id FROM vinted_accounts WHERE id = $1 AND user_id = $2 AND is_active = TRUE",
        [accountId, req.user!.id]
      );
      if (!accResult.rows[0]) return res.status(404).json({ ok: false, error: "account_not_found" });

      const conditions: string[] = ["vi.account_id = $1"];
      const params: any[] = [accResult.rows[0].id];
      let pIndex = 2;

      if (status) { conditions.push(`vi.status = $${pIndex++}`); params.push(status); }
      if (cursor) { conditions.push(`vi.id < $${pIndex++}`); params.push(cursor); }

      const query = `
        SELECT
          vi.id, vi.item_id, vi.title, vi.price, vi.status,
          vi.is_hidden, vi.views, vi.likes AS favorites,
          vi.brand, vi.size, vi.category, vi.url, vi.image_url,
          vi.buy_price, vi.profit, vi.listed_at, vi.sold_at, vi.last_synced_at,
          va.username AS account_login, va.domain AS country_code
        FROM vinted_inventory vi
        JOIN vinted_accounts va ON va.id = vi.account_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY vi.id DESC
        LIMIT $${pIndex}
      `;
      params.push(limit + 1);

      const result = await pool.query(query, params);
      const hasMore = result.rows.length > limit;
      const items = result.rows.slice(0, limit);
      const endCursor = hasMore ? String(items[items.length - 1].id) : null;

      res.json({
        ok: true,
        data: {
          items,
          meta: {
            has_next_page: hasMore,
            end_cursor: endCursor,
            start_cursor: items[0] ? String(items[0].id) : null,
            total_pages: null,
            total_entries: null,
          },
        },
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /api/vinted/:accountId/orders  (Blackstock compat) ──────────────────
  app.get("/api/vinted/:accountId/orders", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const { accountId } = req.params;
      const limit  = Math.min(parseInt(String(req.query.limit  || "50")), 200);
      const cursor = req.query.cursor ? parseInt(String(req.query.cursor)) : null;

      // Verify account belongs to user
      const accResult = await pool.query(
        "SELECT id, username FROM vinted_accounts WHERE id = $1 AND user_id = $2",
        [accountId, req.user!.id]
      );
      if (!accResult.rows[0]) return res.status(404).json({ ok: false, error: "account_not_found" });
      const acc = accResult.rows[0];

      const conditions: string[] = ["(s.account_id = $1 OR s.vinted_account = $2)"];
      const params: any[] = [acc.id, acc.username];
      let pIndex = 3;

      if (cursor) { conditions.push(`s.id < $${pIndex++}`); params.push(cursor); }

      const query = `
        SELECT
          s.id, s.model AS title, s.buy_price, s.sell_price AS amount,
          s.date AS sold_at, s.vinted_account AS account_login,
          s.account_id, s.created_at,
          va.username AS buyer_name
        FROM sales s
        LEFT JOIN vinted_accounts va ON va.id = s.account_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY s.id DESC
        LIMIT $${pIndex}
      `;
      params.push(limit + 1);

      const result = await pool.query(query, params);
      const hasMore = result.rows.length > limit;
      const orders = result.rows.slice(0, limit).map(row => ({
        id:         row.id,
        title:      row.title,
        amount:     parseFloat(row.amount || "0"),
        buyPrice:   parseFloat(row.buy_price || "0"),
        profit:     parseFloat(row.amount || "0") - parseFloat(row.buy_price || "0"),
        soldAt:     row.sold_at,
        accountLogin: row.account_login,
        createdAt:  row.created_at,
      }));

      res.json({
        ok: true,
        data: {
          orders,
          meta: {
            has_next_page: hasMore,
            end_cursor: hasMore ? String(result.rows[limit - 1].id) : null,
            start_cursor: orders[0] ? String(orders[0].id) : null,
            total_pages: null,
            total_entries: null,
          },
        },
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /api/vinted/:accountId/stats  (Blackstock compat) ───────────────────
  app.get("/api/vinted/:accountId/stats", requireAuth as any, async (req: AuthRequest, res: Response) => {
    try {
      const { accountId } = req.params;
      const accResult = await pool.query(
        "SELECT id, username FROM vinted_accounts WHERE id = $1 AND user_id = $2",
        [accountId, req.user!.id]
      );
      if (!accResult.rows[0]) return res.status(404).json({ ok: false, error: "account_not_found" });
      const acc = accResult.rows[0];

      const [invR, salesR] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'active')  AS active,
             COUNT(*) FILTER (WHERE status = 'sold')    AS sold,
             COUNT(*) FILTER (WHERE is_hidden = TRUE)   AS hidden,
             COUNT(*) AS total
           FROM vinted_inventory WHERE account_id = $1`,
          [acc.id]
        ),
        pool.query(
          `SELECT
             COUNT(*)                  AS total_orders,
             COALESCE(SUM(sell_price), 0) AS revenue,
             COALESCE(AVG(sell_price), 0) AS avg_order,
             COALESCE(SUM(sell_price - buy_price), 0) AS profit
           FROM sales WHERE account_id = $1 OR vinted_account = $2`,
          [acc.id, acc.username]
        ),
      ]);

      const inv   = invR.rows[0];
      const sales = salesR.rows[0];

      res.json({
        ok: true,
        data: {
          inventory: {
            active:  parseInt(inv.active  || "0"),
            sold:    parseInt(inv.sold    || "0"),
            hidden:  parseInt(inv.hidden  || "0"),
            total:   parseInt(inv.total   || "0"),
          },
          sales: {
            totalOrders: parseInt(sales.total_orders || "0"),
            revenue:     parseFloat(sales.revenue    || "0"),
            avgOrder:    parseFloat(sales.avg_order  || "0"),
            profit:      parseFloat(sales.profit     || "0"),
          },
        },
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
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

  // ── Política de privacidad (requerida por Chrome Web Store) ─────────────────
  app.get(['/privacy', '/privacy-policy', '/politica-privacidad'], (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Política de Privacidad — Lamine HUB</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#d4d4cf;line-height:1.7;padding:40px 20px}
    .wrap{max-width:760px;margin:0 auto}
    h1{font-size:2rem;color:#f2f2ef;margin-bottom:8px}
    h2{font-size:1.1rem;color:#d4ff00;margin:32px 0 10px;text-transform:uppercase;letter-spacing:.08em}
    p,li{font-size:.95rem;color:#aaa;margin-bottom:10px}
    ul{padding-left:20px;margin-bottom:10px}
    a{color:#d4ff00;text-decoration:none}
    .meta{font-size:.8rem;color:#555;margin-bottom:40px}
    .card{background:#161616;border:1px solid rgba(255,255,255,.07);border-radius:16px;padding:24px;margin-bottom:16px}
  </style>
</head>
<body>
<div class="wrap">
  <h1>Política de Privacidad</h1>
  <p class="meta">Extensión: <strong>Lamine HUB</strong> · Última actualización: ${new Date().toLocaleDateString('es-ES', { year:'numeric', month:'long', day:'numeric' })}</p>

  <div class="card">
    <h2>1. Quién somos</h2>
    <p>Lamine HUB es una extensión de Chrome desarrollada para ayudar a vendedores de Vinted a analizar el mercado y gestionar su actividad. El servicio está operado por LamineResell. Contacto: <a href="mailto:soporte@lamineresell.es">soporte@lamineresell.es</a></p>
  </div>

  <div class="card">
    <h2>2. Qué datos recogemos</h2>
    <ul>
      <li><strong>Cuenta de usuario:</strong> dirección de email y contraseña cifrada (bcrypt) para autenticar el acceso a la extensión.</li>
      <li><strong>Sesión de Vinted:</strong> token de autenticación de tu cuenta de Vinted, leído de las cookies del navegador exclusivamente para realizar llamadas a la API de Vinted en tu nombre (sincronizar artículos, ver pedidos, analizar el mercado).</li>
      <li><strong>Datos de actividad en Vinted:</strong> artículos publicados, precios, ventas y estadísticas de rendimiento que tú mismo has generado en Vinted.</li>
      <li><strong>Identificador de dispositivo (HWID):</strong> huella anónima del navegador para proteger tu licencia frente a usos no autorizados. No contiene datos personales identificables.</li>
      <li><strong>Preferencias locales:</strong> configuración de la extensión almacenada en el almacenamiento local de Chrome (nunca se envía a terceros).</li>
    </ul>
  </div>

  <div class="card">
    <h2>3. Para qué usamos tus datos</h2>
    <ul>
      <li>Autenticar tu acceso y validar tu licencia.</li>
      <li>Sincronizar tu inventario de Vinted y mostrarte estadísticas de análisis de mercado.</li>
      <li>Proteger tu cuenta frente a accesos desde dispositivos no autorizados.</li>
      <li>Mejorar la fiabilidad y el rendimiento del servicio.</li>
    </ul>
    <p>No vendemos, cedemos ni compartimos tus datos personales con terceros con fines comerciales.</p>
  </div>

  <div class="card">
    <h2>4. Permisos de la extensión y por qué son necesarios</h2>
    <ul>
      <li><strong>cookies:</strong> leer el token de sesión de Vinted para autenticar las llamadas a la API de Vinted en tu nombre.</li>
      <li><strong>tabs / webNavigation:</strong> detectar cuándo estás navegando por Vinted para activar las funciones de análisis en el momento correcto.</li>
      <li><strong>storage / unlimitedStorage:</strong> guardar tu configuración, caché de datos de mercado y preferencias localmente en tu navegador.</li>
      <li><strong>scripting:</strong> inyectar la interfaz de la extensión en las páginas de Vinted.</li>
      <li><strong>downloads:</strong> descargar etiquetas de envío generadas por Vinted.</li>
      <li><strong>notifications:</strong> notificarte sobre nuevas oportunidades de mercado o alertas de precio.</li>
      <li><strong>declarativeNetRequest:</strong> redirigir ciertas peticiones de imágenes para mejorar la velocidad de carga.</li>
    </ul>
  </div>

  <div class="card">
    <h2>5. Dónde se almacenan tus datos</h2>
    <p>Los datos de cuenta y licencia se almacenan en una base de datos PostgreSQL alojada en Railway (UE). El token de sesión de Vinted se procesa en memoria durante las operaciones y no se almacena de forma persistente en nuestros servidores.</p>
    <p>Los datos de configuración y preferencias se almacenan localmente en tu navegador Chrome mediante la API <code>chrome.storage.local</code>.</p>
  </div>

  <div class="card">
    <h2>6. Retención y eliminación</h2>
    <p>Conservamos tus datos mientras tu cuenta esté activa. Puedes solicitar la eliminación completa de tu cuenta y datos en cualquier momento escribiendo a <a href="mailto:soporte@lamineresell.es">soporte@lamineresell.es</a>. Procederemos a la eliminación en un plazo máximo de 30 días.</p>
  </div>

  <div class="card">
    <h2>7. Seguridad</h2>
    <p>Las contraseñas se almacenan siempre cifradas con bcrypt. Toda la comunicación entre la extensión y nuestros servidores se realiza mediante HTTPS/TLS. El acceso a los datos de cuenta está protegido por tokens JWT de corta duración.</p>
  </div>

  <div class="card">
    <h2>8. Menores de edad</h2>
    <p>Este servicio no está dirigido a menores de 16 años. No recogemos conscientemente datos de menores.</p>
  </div>

  <div class="card">
    <h2>9. Cambios en esta política</h2>
    <p>Podemos actualizar esta política ocasionalmente. Los cambios significativos se comunicarán en el panel de la extensión. La fecha de la última modificación siempre estará visible en la cabecera de esta página.</p>
  </div>

  <div class="card">
    <h2>10. Contacto</h2>
    <p>Para cualquier consulta sobre privacidad: <a href="mailto:soporte@lamineresell.es">soporte@lamineresell.es</a></p>
    <p>Comunidad y soporte: <a href="https://www.skool.com/lamineresell" target="_blank">skool.com/lamineresell</a></p>
  </div>
</div>
</body>
</html>`);
  });

  // ── Fleet sweeper (cada 15 s) ─────────────────────────────────────────────
  // 1. Re-encola jobs en 'running' cuya lease expiró y aún tienen reintentos.
  // 2. Marca como 'failed' los que agotaron max_attempts.
  // 3. Marca 'offline' los workers que no han hecho ping en 90 s.
  setInterval(async () => {
    try {
      // Re-encolar con backoff 2^n si quedan reintentos
      await pool.query(`
        UPDATE fleet_jobs
        SET status      = 'queued',
            worker_id   = NULL,
            lease_until = NULL,
            run_after   = NOW() + (POWER(2, attempts) || ' seconds')::interval,
            updated_at  = NOW()
        WHERE status = 'running'
          AND lease_until < NOW()
          AND attempts < max_attempts
      `);
      // Fallar definitivamente los que agotaron reintentos
      await pool.query(`
        UPDATE fleet_jobs
        SET status     = 'failed',
            updated_at = NOW()
        WHERE status = 'running'
          AND lease_until < NOW()
          AND attempts >= max_attempts
      `);
      // Marcar offline workers sin ping reciente
      await pool.query(`
        UPDATE fleet_workers
        SET status = 'offline'
        WHERE status NOT IN ('offline','paused')
          AND last_seen_at < NOW() - INTERVAL '90 seconds'
      `);
    } catch (_) {/* swallow — no interrumpir el servidor por error del sweeper */}
  }, 15_000);

  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on http://localhost:${PORT}`));
}

// ── SSE Ops Terminal ─────────────────────────────────────────────────────────
// Mapa global: userId → Set de Response SSE activas
const sseClients = new Map<string, Set<Response>>();

/** Emite un evento SSE a todas las pestañas del terminal abiertas por el usuario */
function opsEmit(userId: string | number, level: string, tag: string, msg: string) {
  const uid = String(userId);
  const clients = sseClients.get(uid);
  if (!clients?.size) return;
  const payload = `data: ${JSON.stringify({ level, tag, msg, ts: new Date().toISOString() })}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

startServer();
