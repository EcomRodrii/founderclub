import pg from "pg";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const { Pool } = pg;

function buildPoolConfig() {
  const url = process.env.DATABASE_URL || "";
  // Solo forzar SSL en conexiones públicas de Railway (proxy externo)
  // Las conexiones internas (*.railway.internal) NO necesitan SSL
  const needsSsl = url.includes("rlwy.net") || url.includes("proxy.rlwy");
  if (needsSsl && url.startsWith("postgresql://")) {
    // Parsear manualmente para evitar que pg override SSL con su parser de URL
    const u = new URL(url);
    return {
      host:     u.hostname,
      port:     Number(u.port) || 5432,
      user:     u.username,
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ""),
      ssl:      { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
    };
  }
  // Railway interno o localhost: dejar que pg maneje la conexión normalmente
  const isProd = process.env.NODE_ENV === "production";
  return {
    connectionString: url,
    ssl: isProd ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  };
}

export const pool = new Pool(buildPoolConfig());

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      is_admin BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id SERIAL PRIMARY KEY,
      key VARCHAR(64) UNIQUE NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      type VARCHAR(20) NOT NULL DEFAULT 'monthly',
      expires_at TIMESTAMP,
      activated_at TIMESTAMP,
      hwid VARCHAR(512),
      ip VARCHAR(64),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      ip VARCHAR(64),
      hwid VARCHAR(512),
      created_at TIMESTAMP DEFAULT NOW(),
      last_seen TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vinted_accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      username VARCHAR(100) NOT NULL,
      cookie TEXT,
      domain VARCHAR(5) DEFAULT 'es',
      is_active BOOLEAN DEFAULT TRUE,
      balance DECIMAL(10,2),
      items_count INTEGER DEFAULT 0,
      sold_count INTEGER DEFAULT 0,
      last_synced_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, username)
    );

    CREATE TABLE IF NOT EXISTS vinted_inventory (
      id SERIAL PRIMARY KEY,
      account_id INTEGER REFERENCES vinted_accounts(id) ON DELETE CASCADE,
      item_id VARCHAR(50) NOT NULL,
      title TEXT,
      price DECIMAL(10,2),
      status VARCHAR(20) DEFAULT 'active',
      is_hidden BOOLEAN DEFAULT FALSE,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      brand VARCHAR(100),
      size VARCHAR(30),
      category VARCHAR(100),
      url TEXT,
      image_url TEXT,
      buy_price DECIMAL(10,2),
      profit DECIMAL(10,2),
      listed_at TIMESTAMP,
      sold_at TIMESTAMP,
      last_synced_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(account_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS vinted_expenses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      account_id INTEGER REFERENCES vinted_accounts(id) ON DELETE SET NULL,
      description TEXT NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      category VARCHAR(50) DEFAULT 'general',
      date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      model VARCHAR(255) NOT NULL,
      buy_price DECIMAL(10,2) NOT NULL,
      sell_price DECIMAL(10,2) NOT NULL,
      date DATE NOT NULL,
      vinted_account VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bazooka_jobs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      title TEXT,
      item_id VARCHAR(50),
      status VARCHAR(20) DEFAULT 'pending',
      note TEXT,
      error_message TEXT,
      vinted_cookies TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sniper_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      item_id VARCHAR(50) NOT NULL,
      item_url TEXT NOT NULL,
      item_title TEXT,
      seller_id VARCHAR(50),
      success BOOLEAN NOT NULL,
      winner_worker INTEGER,
      winner_proxy TEXT,
      transaction_id TEXT,
      purchase_id TEXT,
      fastest_ms INTEGER,
      workers_total INTEGER,
      workers_ok INTEGER,
      session_expired BOOLEAN DEFAULT FALSE,
      captcha_detected BOOLEAN DEFAULT FALSE,
      raw_results JSONB,
      fired_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS proxy_health (
      id SERIAL PRIMARY KEY,
      proxy_label TEXT UNIQUE NOT NULL,
      last_used TIMESTAMP,
      last_status VARCHAR(20),
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      captcha_count INTEGER DEFAULT 0,
      banned BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tongue_prompts (
      brand VARCHAR(30) PRIMARY KEY,
      prompt TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS control_vinted_accounts (
      id SERIAL PRIMARY KEY,
      owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      vinted_username VARCHAR(100) NOT NULL,
      real_name VARCHAR(100),
      gmail VARCHAR(255),
      vinted_pass TEXT,
      phone VARCHAR(50),
      device VARCHAR(200),
      iban VARCHAR(60),
      dac7 BOOLEAN DEFAULT FALSE,
      status VARCHAR(20) DEFAULT 'disponible',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS device_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      install_id TEXT,
      browser_id TEXT,
      hwid TEXT,
      version TEXT,
      ip TEXT,
      user_agent TEXT,
      last_seen TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, install_id)
    );

    CREATE TABLE IF NOT EXISTS whitelist_items (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      item_url TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS whitelist_profiles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL,
      profile_url TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS bazooka_workers (
      name TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'idle',
      active_jobs INTEGER DEFAULT 0,
      version TEXT,
      host TEXT,
      uptime_sec INTEGER,
      last_seen TIMESTAMP DEFAULT NOW()
    );
  `);

  // Migrations — añadir columnas nuevas si no existen
  const migrations = [
    `ALTER TABLE vinted_accounts ADD COLUMN IF NOT EXISTS cookie TEXT`,
    `ALTER TABLE vinted_accounts ADD COLUMN IF NOT EXISTS domain VARCHAR(5) DEFAULT 'es'`,
    `ALTER TABLE vinted_accounts ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`,
    `ALTER TABLE vinted_accounts ADD COLUMN IF NOT EXISTS balance DECIMAL(10,2)`,
    `ALTER TABLE vinted_accounts ADD COLUMN IF NOT EXISTS items_count INTEGER DEFAULT 0`,
    `ALTER TABLE vinted_accounts ADD COLUMN IF NOT EXISTS sold_count INTEGER DEFAULT 0`,
    `ALTER TABLE vinted_accounts ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP`,
    `ALTER TABLE vinted_accounts ADD COLUMN IF NOT EXISTS label TEXT`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES vinted_accounts(id) ON DELETE SET NULL`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS notes TEXT`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS platform VARCHAR(30) DEFAULT 'vinted'`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS boost_cost DECIMAL(10,2) DEFAULT 0`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS shipping_cost DECIMAL(10,2) DEFAULT 0`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS supplier VARCHAR(255)`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_filename VARCHAR(255)`,
    // Permitir buy_price 0 (las compras pueden venir solo del lote)
    `ALTER TABLE sales ALTER COLUMN buy_price SET DEFAULT 0`,
    `ALTER TABLE sales ALTER COLUMN buy_price DROP NOT NULL`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS refunded BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMP`,
    // Tabla nueva de compras (facturas de lote) — separadas de las ventas
    `CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      supplier VARCHAR(255),
      total_amount DECIMAL(10,2) NOT NULL,
      units INTEGER DEFAULT 1,
      date DATE NOT NULL,
      invoice_filename VARCHAR(255),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_purchases_user_date ON purchases(user_id, date DESC)`,
    `ALTER TABLE sniper_history ADD COLUMN IF NOT EXISTS purchase_id TEXT`,
    // Bazooka worker-fleet columns on top of the existing bazooka_jobs schema
    `ALTER TABLE bazooka_jobs ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'report'`,
    `ALTER TABLE bazooka_jobs ADD COLUMN IF NOT EXISTS params JSONB DEFAULT '{}'::jsonb`,
    `ALTER TABLE bazooka_jobs ADD COLUMN IF NOT EXISTS claimed_by TEXT`,
    `ALTER TABLE bazooka_jobs ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP`,
    `ALTER TABLE bazooka_jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP`,
    `ALTER TABLE bazooka_jobs ADD COLUMN IF NOT EXISTS duration_ms INTEGER`,
    `ALTER TABLE bazooka_jobs ADD COLUMN IF NOT EXISTS error TEXT`,
    `ALTER TABLE bazooka_jobs ALTER COLUMN vinted_cookies DROP NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_bazooka_jobs_pending ON bazooka_jobs(status, created_at) WHERE status = 'pending'`,

    // ── Columnas HWID en licenses (migración — las tablas antiguas no las tienen) ─
    `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS hwid VARCHAR(512)`,
    `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP`,
    `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS ip VARCHAR(64)`,

    // ── vinted_accounts: vinted_id para upsert fiable ─────────────────────────
    `ALTER TABLE vinted_accounts ADD COLUMN IF NOT EXISTS vinted_id VARCHAR(50)`,
    `ALTER TABLE vinted_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`,
    `CREATE UNIQUE INDEX IF NOT EXISTS vinted_accounts_user_vid_idx ON vinted_accounts(user_id, vinted_id) WHERE vinted_id IS NOT NULL`,

    // ── vinted_accounts: session_cookie = full cookie string for server-side Vinted calls ─
    `ALTER TABLE vinted_accounts ADD COLUMN IF NOT EXISTS session_cookie TEXT`,

    // ── Extension HWID sessions ────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS extension_sessions (
      id TEXT PRIMARY KEY,
      license_key VARCHAR(64) NOT NULL,
      hwid VARCHAR(512) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL,
      last_seen_at TIMESTAMP DEFAULT NOW(),
      revoked BOOLEAN DEFAULT FALSE,
      ip VARCHAR(64)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ext_sessions_license ON extension_sessions(license_key)`,
    `CREATE INDEX IF NOT EXISTS idx_ext_sessions_hwid ON extension_sessions(hwid)`,

    // ── Permisos por licencia: features define qué secciones puede ver el usuario ─
    // Default: solo 'photos' (Fantasma). Academia desbloquea todo.
    `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS features TEXT[] NOT NULL DEFAULT ARRAY['photos']::TEXT[]`,

    // ── Tabla de jobs de Boost (automatización de subida de artículos) ────────
    `CREATE TABLE IF NOT EXISTS boost_requests (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      account_id   INTEGER REFERENCES vinted_accounts(id) ON DELETE SET NULL,
      account_login VARCHAR(100),
      items_count  INTEGER DEFAULT 0,
      status       VARCHAR(20) DEFAULT 'pending',
      note         TEXT,
      error_msg    TEXT,
      created_at   TIMESTAMP DEFAULT NOW(),
      updated_at   TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_boost_requests_user ON boost_requests(user_id, created_at DESC)`,

    // ── Label references (admin uploads real reference photos per brand/size) ──
    `CREATE TABLE IF NOT EXISTS label_references (
      id           SERIAL PRIMARY KEY,
      brand        VARCHAR(30) NOT NULL,
      size_us      VARCHAR(10),
      label_type   VARCHAR(10) NOT NULL DEFAULT 'tongue',
      image_base64 TEXT,
      codes_json   JSONB NOT NULL DEFAULT '{}',
      notes        TEXT,
      created_at   TIMESTAMP DEFAULT NOW(),
      UNIQUE(brand, size_us, label_type)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_label_refs_brand ON label_references(brand, label_type)`,

    // ── Box label prompts per brand ────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS box_prompts (
      brand      VARCHAR(30) PRIMARY KEY,
      prompt     TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMP DEFAULT NOW()
    )`,

    // ── Token de generación de imágenes por licencia ───────────────────────────
    // NULL = ilimitado, número = tokens restantes
    `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS image_tokens INTEGER DEFAULT NULL`,

    // ── Multicuenta roster: límite de cuentas por licencia ─────────────────────
    `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS max_accounts INTEGER NOT NULL DEFAULT 5`,

    // ── Roster de cuentas Vinted vinculadas a una licencia ─────────────────────
    // SOLO metadatos (login, vinted_id, país…) — NUNCA cookies ni contraseñas.
    // vinted_id UNIQUE global = 1 cuenta : 1 licencia.
    `CREATE TABLE IF NOT EXISTS extension_vinted_accounts (
      id           BIGSERIAL PRIMARY KEY,
      license_id   INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
      vinted_id    TEXT NOT NULL UNIQUE,
      login        TEXT,
      title        TEXT,
      email        TEXT,
      country_code TEXT,
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ext_vac_license ON extension_vinted_accounts(license_id)`,

    // ── FASE 3: Fleet workers (1 perfil de navegador = 1 worker Vinted) ──────────
    // device_hwid identifica de forma estable el perfil de Chrome.
    // token = secreto portador de larga vida (rotado solo en re-registro explícito).
    `CREATE TABLE IF NOT EXISTS fleet_workers (
      id           BIGSERIAL PRIMARY KEY,
      license_id   INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
      vinted_id    TEXT,
      device_hwid  TEXT NOT NULL DEFAULT '',
      token        TEXT NOT NULL UNIQUE,
      ext_version  TEXT,
      status       TEXT NOT NULL DEFAULT 'online',
      saturation   INT NOT NULL DEFAULT 0,
      running_jobs INT NOT NULL DEFAULT 0,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (license_id, device_hwid)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fleet_workers_license ON fleet_workers(license_id)`,

    // ── FASE 3: Cola de trabajos distribuida ──────────────────────────────────────
    // Claim atómico: FOR UPDATE SKIP LOCKED en GET /fleet/worker/jobs/next.
    // NUNCA guardar cookies/credenciales en payload — solo ids y parámetros.
    `CREATE TABLE IF NOT EXISTS fleet_jobs (
      id               BIGSERIAL PRIMARY KEY,
      license_id       INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
      target_vinted_id TEXT,
      type             TEXT NOT NULL,
      payload          JSONB NOT NULL DEFAULT '{}',
      status           TEXT NOT NULL DEFAULT 'queued',
      priority         INT NOT NULL DEFAULT 0,
      attempts         INT NOT NULL DEFAULT 0,
      max_attempts     INT NOT NULL DEFAULT 3,
      run_after        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_until      TIMESTAMPTZ,
      worker_id        BIGINT REFERENCES fleet_workers(id) ON DELETE SET NULL,
      result           JSONB,
      error            TEXT,
      started_at       TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fleet_jobs_claim
       ON fleet_jobs (priority DESC, created_at)
       WHERE status = 'queued'`,
    `CREATE INDEX IF NOT EXISTS idx_fleet_jobs_license ON fleet_jobs(license_id)`,

    // ── DROPSHIPPING ──────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS dropship_products (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      temu_url     TEXT NOT NULL,
      temu_cost    NUMERIC(10,2),
      vinted_price NUMERIC(10,2),
      title        TEXT NOT NULL DEFAULT '',
      stock        INTEGER DEFAULT 1,
      notes        TEXT,
      is_active    BOOLEAN DEFAULT TRUE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS dropship_orders (
      id                   SERIAL PRIMARY KEY,
      user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id           INTEGER REFERENCES dropship_products(id) ON DELETE SET NULL,
      vinted_order_id      TEXT NOT NULL,
      buyer_name           TEXT,
      buyer_address_enc    TEXT,
      vinted_item_title    TEXT,
      vinted_amount        NUMERIC(10,2),
      vinted_sale_data     JSONB DEFAULT '{}',
      temu_order_id        TEXT,
      temu_cart_screenshot TEXT,
      status               TEXT NOT NULL DEFAULT 'pending_purchase'
        CHECK (status IN ('pending_purchase','purchased_temu','in_transit','received','shipped')),
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, vinted_order_id)
    )`,
    `CREATE TABLE IF NOT EXISTS temu_credentials (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
      cookies_enc TEXT NOT NULL,
      email       TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_dropship_orders_user ON dropship_orders(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dropship_products_user ON dropship_products(user_id)`,
    `ALTER TABLE dropship_products ADD COLUMN IF NOT EXISTS vinted_listing_id TEXT`,
    `ALTER TABLE dropship_products ADD COLUMN IF NOT EXISTS vinted_listing_url TEXT`,
    `ALTER TABLE dropship_products ADD COLUMN IF NOT EXISTS temu_title TEXT`,
    `ALTER TABLE dropship_products ADD COLUMN IF NOT EXISTS temu_images JSONB DEFAULT '[]'::jsonb`,
    `ALTER TABLE dropship_products ADD COLUMN IF NOT EXISTS temu_description TEXT`,
    `ALTER TABLE dropship_products ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT`,
    `ALTER TABLE temu_credentials ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT`,
  ];
  for (const sql of migrations) {
    await pool.query(sql).catch(() => {}); // silently ignore if column already exists
  }

  // Create first admin from env if no admins exist
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminUsername = process.env.ADMIN_USERNAME || "admin";

  if (adminEmail && adminPassword) {
    const existing = await pool.query("SELECT id FROM users WHERE is_admin = TRUE LIMIT 1");
    if (existing.rows.length === 0) {
      const bcryptMod = await import("bcryptjs");
      const bcrypt = bcryptMod.default ?? bcryptMod;
      const hash = await bcrypt.hash(adminPassword, 12);
      await pool.query(
        "INSERT INTO users (username, email, password_hash, is_admin) VALUES ($1, $2, $3, TRUE) ON CONFLICT DO NOTHING",
        [adminUsername, adminEmail, hash]
      );
      console.log(`Admin creado: ${adminEmail}`);
    }
  }

  console.log("Base de datos inicializada.");
}
