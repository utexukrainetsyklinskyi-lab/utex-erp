import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dbPath = path.resolve(process.env.DB_PATH || path.join(root, '.data', 'utex.sqlite3'));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath, { timeout: 5000 });
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS auth_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT, password TEXT NOT NULL, last_login TEXT,
  is_superuser INTEGER NOT NULL DEFAULT 0, username TEXT NOT NULL UNIQUE,
  last_name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
  is_staff INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
  date_joined TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, first_name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS warehouse_client (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS warehouse_nomenclature (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  item_type TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'км', structure_sku TEXT NOT NULL DEFAULT '', fiber_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS warehouse_specification (
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES warehouse_nomenclature(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES warehouse_nomenclature(id) ON DELETE CASCADE, quantity REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS warehouse_markingtemplate (
  id INTEGER PRIMARY KEY AUTOINCREMENT, template_name TEXT NOT NULL, client_id INTEGER NOT NULL REFERENCES warehouse_client(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES warehouse_nomenclature(id) ON DELETE CASCADE, text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS warehouse_workcenter (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS warehouse_productrouting (
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES warehouse_nomenclature(id) ON DELETE CASCADE,
  work_center_id INTEGER NOT NULL REFERENCES warehouse_workcenter(id) ON DELETE CASCADE,
  speed_m_per_min REAL NOT NULL DEFAULT 0, is_primary INTEGER NOT NULL DEFAULT 1, ketr TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS warehouse_order (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_number TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES warehouse_client(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES warehouse_nomenclature(id) ON DELETE CASCADE,
  fiber_type TEXT NOT NULL DEFAULT '', quantity REAL NOT NULL, length_per_drum REAL,
  status TEXT NOT NULL DEFAULT 'new', deadline TEXT NOT NULL,
  skip_fiber_painting INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS warehouse_productionplan (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES warehouse_order(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES warehouse_nomenclature(id) ON DELETE CASCADE,
  fiber_type TEXT NOT NULL DEFAULT '', quantity_needed REAL NOT NULL,
  work_center_id INTEGER REFERENCES warehouse_workcenter(id) ON DELETE RESTRICT,
  duration_hours REAL NOT NULL DEFAULT 0, planned_start TEXT, planned_end TEXT,
  stage_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued'
);
CREATE TABLE IF NOT EXISTS warehouse_employee (
  id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  position TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS warehouse_productionlog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  production_plan_id INTEGER REFERENCES warehouse_productionplan(id) ON DELETE SET NULL,
  quantity_produced REAL NOT NULL DEFAULT 0, date_created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  production_type TEXT NOT NULL DEFAULT 'Серійна', operator_id INTEGER NOT NULL REFERENCES warehouse_employee(id) ON DELETE RESTRICT,
  has_deviation INTEGER NOT NULL DEFAULT 0, deviation_comment TEXT NOT NULL DEFAULT '',
  has_downtime INTEGER NOT NULL DEFAULT 0, downtime_hours INTEGER NOT NULL DEFAULT 0,
  downtime_minutes INTEGER NOT NULL DEFAULT 0, downtime_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_plan_order ON warehouse_productionplan(order_id);
CREATE INDEX IF NOT EXISTS idx_plan_schedule ON warehouse_productionplan(planned_start, planned_end);
CREATE INDEX IF NOT EXISTS idx_log_plan ON warehouse_productionlog(production_plan_id);
`);

const orderColumns = db.pragma('table_info(warehouse_order)');
if (!orderColumns.some(column => column.name === 'skip_fiber_painting')) {
  db.exec('ALTER TABLE warehouse_order ADD COLUMN skip_fiber_painting INTEGER NOT NULL DEFAULT 0');
}

export function modelRows(table, orderBy = 'id DESC') {
  const allowed = new Set(['warehouse_client', 'warehouse_nomenclature', 'warehouse_workcenter',
    'warehouse_productrouting', 'warehouse_specification', 'warehouse_employee', 'warehouse_markingtemplate']);
  if (!allowed.has(table)) throw new Error('Unknown table');
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
}
