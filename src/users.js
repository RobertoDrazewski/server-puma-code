// Usuarios propios del panel (mismos correos que el panel de Puma Code), clave con scrypt, sesiones en cookie.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, now, audit } from './db.js';
import { cfg, displayName, PROFILES } from './config.js';

const scrypt = promisify(crypto.scrypt);
export const ROLES = ['superadmin', 'admin', 'viewer'];
export const isAdmin = (u) => u && (u.role === 'admin' || u.role === 'superadmin');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64);
  return `s1$${salt.toString('base64')}$${h.toString('base64')}`;
}
async function checkPw(pw, stored) {
  const [v, s, h] = String(stored || '').split('$');
  if (v !== 's1') return false;
  const calc = await scrypt(pw, Buffer.from(s, 'base64'), 64);
  const want = Buffer.from(h, 'base64');
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}

export function checkPolicy(pw, email = '') {
  if (typeof pw !== 'string' || pw.length < 10) return 'La clave debe tener al menos 10 caracteres.';
  if (pw.length > 200) return 'La clave es demasiado larga.';
  if (email && pw.toLowerCase() === email.toLowerCase()) return 'La clave no puede ser tu correo.';
  return '';
}

const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const pub = (u) => u && { email: u.email, name: u.name, call: u.call || firstName(u.name), title: u.title || '', boss: !!PROFILES[u.email]?.boss, role: u.role, photo: u.photo || '', mustChange: !!u.must_change, disabled: !!u.disabled, lastLogin: u.last_login || null, created: u.created };
export const getUser = (email) => db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase());
export const publicUser = pub;
export const listUsers = () => db.prepare('SELECT * FROM users ORDER BY created').all().map(pub);

export async function createUser({ email, name, role, password, mustChange = true, title = '', call = '' }) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error('Correo inválido.');
  if (!ROLES.includes(role)) throw new Error('Rol inválido.');
  if (getUser(email)) throw new Error('Ese correo ya tiene acceso.');
  const bad = checkPolicy(password, email); if (bad) throw new Error(bad);
  db.prepare('INSERT INTO users (email,name,role,hash,must_change,created) VALUES (?,?,?,?,?,?)')
    .run(email, String(name || displayName(email)).trim().slice(0, 60), role, await hashPw(password), mustChange ? 1 : 0, now());
  db.prepare('UPDATE users SET title=?, call=? WHERE email=?').run(String(title || '').trim().slice(0, 80), String(call || '').trim().slice(0, 30), email);
}

export async function updateUser(email, { name, role, password, disabled, title, call }) {
  const u = getUser(email); if (!u) throw new Error('No existe ese usuario.');
  if (name != null) db.prepare('UPDATE users SET name=? WHERE email=?').run(String(name).trim().slice(0, 60) || u.name, u.email);
  if (title != null) db.prepare('UPDATE users SET title=? WHERE email=?').run(String(title).trim().slice(0, 80), u.email);
  if (call != null) db.prepare('UPDATE users SET call=? WHERE email=?').run(String(call).trim().slice(0, 30), u.email);
  if (role != null) {
    if (!ROLES.includes(role)) throw new Error('Rol inválido.');
    if (u.role === 'superadmin' && role !== 'superadmin' && supers() <= 1) throw new Error('Tiene que quedar al menos un superadmin.');
    db.prepare('UPDATE users SET role=? WHERE email=?').run(role, u.email);
  }
  if (disabled != null) {
    if (disabled && u.role === 'superadmin' && supers() <= 1) throw new Error('No podés desactivar al único superadmin.');
    db.prepare('UPDATE users SET disabled=? WHERE email=?').run(disabled ? 1 : 0, u.email);
    if (disabled) db.prepare('DELETE FROM auth_sessions WHERE email=?').run(u.email);
  }
  if (password) {
    const bad = checkPolicy(password, u.email); if (bad) throw new Error(bad);
    db.prepare('UPDATE users SET hash=?, must_change=1 WHERE email=?').run(await hashPw(password), u.email);
    db.prepare('DELETE FROM auth_sessions WHERE email=?').run(u.email);
  }
}
const supers = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role='superadmin' AND disabled=0").get().c;

export function deleteUser(email) {
  const u = getUser(email); if (!u) throw new Error('No existe ese usuario.');
  if (u.role === 'superadmin' && supers() <= 1) throw new Error('No podés borrar al único superadmin.');
  db.prepare('DELETE FROM users WHERE email=?').run(u.email);
  db.prepare('DELETE FROM auth_sessions WHERE email=?').run(u.email);
}

export async function changeOwnPassword(email, current, next) {
  const u = getUser(email);
  if (!u || !(await checkPw(current, u.hash))) throw new Error('La clave actual no es correcta.');
  const bad = checkPolicy(next, email); if (bad) throw new Error(bad);
  if (next === current) throw new Error('La nueva clave tiene que ser distinta.');
  db.prepare('UPDATE users SET hash=?, must_change=0 WHERE email=?').run(await hashPw(next), email);
}

export function setPhoto(email, dataUrl) {
  if (dataUrl && !(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) && dataUrl.length < 300000)) throw new Error('Foto inválida o muy pesada.');
  db.prepare('UPDATE users SET photo=? WHERE email=?').run(dataUrl || '', email);
}

// ---------- Sesiones ----------
const fails = new Map(); // ip|email -> {n, until}
const LIMIT = 6, LOCK_MS = 15 * 60e3;

export async function login(email, password, ip) {
  email = String(email || '').trim().toLowerCase();
  const key = `${ip}|${email}`, f = fails.get(key);
  if (f && f.until > Date.now()) throw new Error('Demasiados intentos. Probá de nuevo en unos minutos.');
  const u = getUser(email);
  const ok = u && !u.disabled && (await checkPw(String(password || ''), u.hash));
  if (!ok) {
    const n = (f?.n || 0) + 1;
    fails.set(key, { n, until: n >= LIMIT ? Date.now() + LOCK_MS : 0 });
    audit(email || '?', 'login-fallido', ip);
    throw new Error('Correo o clave incorrectos.');
  }
  fails.delete(key);
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = now() + cfg.sessionDays * 86400;
  db.prepare('INSERT INTO auth_sessions (hash,email,exp,ts) VALUES (?,?,?,?)').run(sha(token), u.email, exp, now());
  db.prepare('UPDATE users SET last_login=? WHERE email=?').run(now(), u.email);
  audit(u.email, 'login', ip);
  return { token, exp, user: pub(u) };
}

export function logout(token) { if (token) db.prepare('DELETE FROM auth_sessions WHERE hash=?').run(sha(token)); }

export function userFromToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT email, exp FROM auth_sessions WHERE hash=?').get(sha(token));
  if (!s || s.exp < now()) return null;
  const u = getUser(s.email);
  return u && !u.disabled ? pub(u) : null;
}

// ---------- Primer arranque: crea los accesos definidos por variables de entorno ----------
export async function seedUsers() {
  const hasSuper = !!db.prepare("SELECT 1 FROM users WHERE role='superadmin'").get();
  let wanted = [
    ...cfg.admins.map((email, i) => ({ email, role: i === 0 && !hasSuper ? 'superadmin' : 'admin' })),
    ...cfg.viewers.map((email) => ({ email, role: 'viewer' })),
  ];
  if (!wanted.length && !cfg.prod && !db.prepare('SELECT 1 FROM users LIMIT 1').get()) wanted = [{ email: 'admin@puma.local', role: 'superadmin' }];
  if (!wanted.length && !db.prepare('SELECT 1 FROM users LIMIT 1').get()) console.warn('AVISO: no hay usuarios. Definí ADMIN_EMAILS para crear el superadmin.');
  for (const w of wanted) {
    if (getUser(w.email)) continue;
    const pw = cfg.bootstrapPassword || crypto.randomBytes(9).toString('base64url');
    await createUser({ email: w.email, name: displayName(w.email), role: w.role, password: pw, mustChange: true });
    console.log(`\n  Acceso creado: ${w.email} (${w.role})` + (cfg.bootstrapPassword ? '  · clave inicial = BOOTSTRAP_PASSWORD' : `\n  Clave temporal: ${pw}`) + '\n  (se te pide cambiarla al primer ingreso)\n');
  }
}

// Completa nombre, trato y cargo de Roberto y Mauro la primera vez (sin pisar lo que ya se cambió a mano).
export function applyProfiles() {
  for (const [email, p] of Object.entries(PROFILES)) {
    const u = getUser(email); if (!u) continue;
    const auto = !u.name || u.name === displayName(email) || u.name === displayName(email).split(' ')[0];
    if (auto) db.prepare('UPDATE users SET name=? WHERE email=?').run(p.name, email);
    if (!u.call) db.prepare('UPDATE users SET call=? WHERE email=?').run(p.call, email);
    if (!u.title) db.prepare('UPDATE users SET title=? WHERE email=?').run(p.title, email);
  }
}
