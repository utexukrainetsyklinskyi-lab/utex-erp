import crypto from 'node:crypto';
import { db } from './database.js';

const iterationsMin = 1;

export function verifyPassword(password, encoded) {
  if (typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const rounds = Number(parts[1]);
  if (!Number.isSafeInteger(rounds) || rounds < iterationsMin || rounds > 5_000_000) return false;
  try {
    const actual = crypto.pbkdf2Sync(password, parts[2], rounds, 32, 'sha256');
    const expected = Buffer.from(parts[3], 'base64');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function encodePassword(password) {
  const rounds = 1_000_000;
  const salt = crypto.randomBytes(18).toString('hex');
  const digest = crypto.pbkdf2Sync(password, salt, rounds, 32, 'sha256').toString('base64');
  return `pbkdf2_sha256$${rounds}$${salt}$${digest}`;
}

export function createCsrfToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function loginUser(username, password) {
  const user = db.prepare(`SELECT id, username, first_name, last_name, password, is_active, is_staff, is_superuser
    FROM auth_user WHERE username = ? COLLATE NOCASE`).get(username.trim());
  if (!user || !user.is_active || (!user.is_staff && !user.is_superuser) || !verifyPassword(password, user.password)) {
    return null;
  }
  db.prepare('UPDATE auth_user SET last_login = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  return { id: user.id, username: user.username, firstName: user.first_name, lastName: user.last_name,
    isStaff: Boolean(user.is_staff), isSuperuser: Boolean(user.is_superuser) };
}

export function loadUser(req, res, next) {
  if (!req.session?.userId) {
    req.user = null;
    return next();
  }
  const row = db.prepare(`SELECT id, username, first_name, last_name, is_active, is_staff, is_superuser
    FROM auth_user WHERE id = ?`).get(req.session.userId);
  if (!row || !row.is_active || (!row.is_staff && !row.is_superuser)) {
    req.session = null;
    req.user = null;
  } else {
    req.user = { id: row.id, username: row.username, firstName: row.first_name, lastName: row.last_name,
      isStaff: Boolean(row.is_staff), isSuperuser: Boolean(row.is_superuser) };
  }
  next();
}

export function ensureCsrf(req, res, next) {
  if (!req.session) req.session = {};
  if (!req.session.csrf) req.session.csrf = createCsrfToken();
  res.locals.csrfToken = req.session.csrf;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user?.isSuperuser) return res.status(403).send('Доступ лише для адміністратора.');
  next();
}

export function requireCsrf(req, res, next) {
  const supplied = req.body?._csrf || req.get('X-CSRF-Token');
  const expected = req.session?.csrf;
  const suppliedBytes = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
  const expectedBytes = typeof expected === 'string' ? Buffer.from(expected) : Buffer.alloc(0);
  if (!suppliedBytes.length || suppliedBytes.length !== expectedBytes.length ||
      !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) {
    return res.status(403).send('CSRF token is missing or invalid. Reload the page and try again.');
  }
  next();
}
