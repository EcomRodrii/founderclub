import pg from "pg";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

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
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, username)
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
  `);

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
