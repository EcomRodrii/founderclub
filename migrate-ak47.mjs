/**
 * migrate-ak47.mjs
 * Migra usuarios y licencias del ak47-worker-backend (SQLite)
 * al founderclub principal (PostgreSQL en Railway).
 *
 * Uso: node migrate-ak47.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Conexiones ────────────────────────────────────────────────────────────────

const SQLITE_PATH = process.env.SQLITE_PATH
  || '/Users/marcosrocarodriguez/Desktop/SCRIPT LAMINE-1-1-1/server/licenses-local.db';

const DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:YNNPzczmDhVjCEoAzPptxwNGkaCaOYXW@viaduct.proxy.rlwy.net:22470/railway';

const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Leer SQLite ───────────────────────────────────────────────────────────────

console.log('📂 Leyendo SQLite:', SQLITE_PATH);
const sqlite = new DatabaseSync(SQLITE_PATH);

const sqliteUsers = sqlite.prepare(`
  SELECT id, email, password_hash, role, created_at
  FROM users
  ORDER BY id ASC
`).all();

const sqliteLicenses = sqlite.prepare(`
  SELECT l.user_id, l.status, l.plan, l.expires_at, l.created_at, l.activated_at, l.notes, u.email
  FROM licenses l
  JOIN users u ON u.id = l.user_id
  WHERE l.status = 'active'
  ORDER BY l.user_id ASC
`).all();

console.log(`📊 Usuarios en SQLite: ${sqliteUsers.length}`);
console.log(`📊 Licencias activas en SQLite: ${sqliteLicenses.length}`);

// ── Migrar ────────────────────────────────────────────────────────────────────

let usersInserted = 0;
let usersSkipped = 0;
let licensesInserted = 0;
let licensesSkipped = 0;

const emailToNewId = {};

for (const u of sqliteUsers) {
  const email = u.email.trim().toLowerCase();
  // Generar username desde email (igual que hace founderclub en /auth/register)
  const username = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20) || 'user';
  const isAdmin = u.role === 'admin';

  try {
    // Intentar insertar — ON CONFLICT DO NOTHING si ya existe
    const res = await pool.query(
      `INSERT INTO users (username, email, password_hash, is_admin, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [username, email, u.password_hash, isAdmin, u.created_at || new Date()]
    );

    if (res.rows[0]) {
      emailToNewId[email] = res.rows[0].id;
      usersInserted++;
    } else {
      // Ya existía — obtener su id
      const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
      emailToNewId[email] = existing.rows[0]?.id;
      usersSkipped++;
    }
  } catch (err) {
    console.error(`  ✗ Error usuario ${email}:`, err.message);
    usersSkipped++;
  }
}

console.log(`✅ Usuarios migrados: ${usersInserted} nuevos, ${usersSkipped} ya existían`);

// Generar clave única para cada licencia migrada
function genKey(email) {
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  const prefix = email.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X');
  return `AK-${prefix}-${rand}-MIGR`;
}

for (const l of sqliteLicenses) {
  const email = l.email.trim().toLowerCase();
  const userId = emailToNewId[email];
  if (!userId) { licensesSkipped++; continue; }

  // Mapear plan ak47 → tipo founderclub
  const typeMap = { standard: 'monthly', premium: 'lifetime', pro: 'lifetime', basic: 'monthly' };
  const licType = typeMap[l.plan] || 'monthly';

  try {
    const key = genKey(email);
    await pool.query(
      `INSERT INTO licenses (key, user_id, type, is_active, expires_at, activated_at, created_at)
       VALUES ($1, $2, $3, TRUE, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [key, userId, licType,
       l.expires_at ? new Date(l.expires_at) : null,
       l.activated_at ? new Date(l.activated_at) : new Date(),
       l.created_at ? new Date(l.created_at) : new Date()]
    );
    // Marcar como academia (acceso total) si tenía licencia activa
    await pool.query(
      `UPDATE licenses SET features = ARRAY['all']::TEXT[] WHERE key = $1`,
      [key]
    );
    licensesInserted++;
  } catch (err) {
    console.error(`  ✗ Error licencia ${email}:`, err.message);
    licensesSkipped++;
  }
}

console.log(`✅ Licencias migradas: ${licensesInserted} nuevas, ${licensesSkipped} omitidas`);

await pool.end();
sqlite.close();
console.log('\n🎉 Migración completada.');
