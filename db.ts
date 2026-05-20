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
    };
  }
  // Railway interno o localhost: dejar que pg maneje la conexión normalmente
  const isProd = process.env.NODE_ENV === "production";
  return {
    connectionString: url,
    ssl: isProd ? { rejectUnauthorized: false } : false,
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
