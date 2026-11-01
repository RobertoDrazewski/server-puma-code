// Base SQLite liviana (módulo nativo de Node, sin dependencias externas).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';

fs.mkdirSync(cfg.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(cfg.dataDir, 'station.db'));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS samples (ts INTEGER, name TEXT, cpu REAL, mem INTEGER, rx INTEGER, tx INTEGER);
CREATE INDEX IF NOT EXISTS idx_samples ON samples (name, ts);
CREATE TABLE IF NOT EXISTS host_samples (ts INTEGER, cpu REAL, mem_used INTEGER, mem_total INTEGER, load1 REAL, disk_used INTEGER, disk_total INTEGER);
CREATE INDEX IF NOT EXISTS idx_host ON host_samples (ts);
CREATE TABLE IF NOT EXISTS checks (ts INTEGER, target TEXT, ok INTEGER, ms INTEGER, status INTEGER);
CREATE INDEX IF NOT EXISTS idx_checks ON checks (target, ts);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, level TEXT, kind TEXT, subject TEXT, message TEXT);
CREATE TABLE IF NOT EXISTS known (name TEXT PRIMARY KEY, first_seen INTEGER);
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, user TEXT, kind TEXT, text TEXT, due TEXT, done INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, user TEXT, kind TEXT, summary TEXT);
CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, calls INTEGER);
CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT, role TEXT, hash TEXT, photo TEXT, must_change INTEGER DEFAULT 1, created INTEGER, last_login INTEGER, disabled INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS auth_sessions (hash TEXT PRIMARY KEY, email TEXT, exp INTEGER, ts INTEGER);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, user TEXT, action TEXT, detail TEXT);
`);

export const now = () => Math.floor(Date.now() / 1000);

export function audit(user, action, detail = '') {
  db.prepare('INSERT INTO audit (ts, user, action, detail) VALUES (?,?,?,?)').run(now(), user, action, String(detail).slice(0, 500));
}

export function addEvent(level, kind, subject, message) {
  db.prepare('INSERT INTO events (ts, level, kind, subject, message) VALUES (?,?,?,?,?)').run(now(), level, kind, subject, message);
}

export function prune() {
  const cut = now() - cfg.retainDays * 86400;
  db.prepare('DELETE FROM samples WHERE ts < ?').run(cut);
  db.prepare('DELETE FROM host_samples WHERE ts < ?').run(cut);
  db.prepare('DELETE FROM checks WHERE ts < ?').run(cut);
  db.prepare('DELETE FROM events WHERE ts < ?').run(now() - 30 * 86400);
  db.prepare('DELETE FROM auth_sessions WHERE exp < ?').run(now());
  db.prepare('DELETE FROM audit WHERE ts < ?').run(now() - 90 * 86400);
}
