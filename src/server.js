import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.js';
import { requireUser, requireAdmin, requireSuper, cfGate, identify, COOKIE, cookieValue } from './auth.js';
import * as users from './users.js';
import { db, audit } from './db.js';
import { state, startCollector, history } from './collector.js';
import * as docker from './docker.js';
import { briefing, closingQuestion, closingAnswer, pendingNotes, aiStatus } from './briefing.js';
import { attachTerminal, ensureKey, publicKey } from './terminal.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '400kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'");
  next();
});

// Sin autenticación: solo para el healthcheck del despliegue.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Capa extra opcional: Cloudflare Access (si está configurado).
app.use(cfGate);

// Protección CSRF: los pedidos que cambian datos tienen que venir del mismo origen.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const o = req.headers.origin;
  if (o) { try { if (new URL(o).host !== req.headers.host) return res.status(403).json({ error: 'Origen no permitido' }); } catch { return res.status(403).end(); } }
  next();
});

const cookieOpts = (req, exp) => `${COOKIE}=${exp.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${exp.age}${req.secure ? '; Secure' : ''}`;

app.post('/api/auth/login', async (req, res) => {
  try {
    const out = await users.login(req.body?.email, req.body?.password, req.ip);
    res.setHeader('Set-Cookie', cookieOpts(req, { token: out.token, age: cfg.sessionDays * 86400 }));
    res.json({ user: out.user });
  } catch (e) { res.status(401).json({ error: e.message }); }
});
app.post('/api/auth/logout', (req, res) => {
  users.logout(cookieValue(req.headers.cookie, COOKIE));
  res.setHeader('Set-Cookie', cookieOpts(req, { token: '', age: 0 }));
  res.json({ ok: true });
});

app.use('/api', requireUser);

const meOut = (u) => ({ ...u, terminal: cfg.terminalEnabled && users.isAdmin(u), terminalMode: cfg.terminalMode, ai: aiStatus() });
app.get('/api/me', (req, res) => res.json(meOut(req.user)));
app.post('/api/me/password', async (req, res) => {
  try {
    await users.changeOwnPassword(req.user.email, req.body?.current, req.body?.next);
    audit(req.user.email, 'cambio-clave', '');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/me/photo', (req, res) => {
  try { users.setPhoto(req.user.email, req.body?.photo || ''); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/me/name', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Nombre vacío' });
  db.prepare('UPDATE users SET name=? WHERE email=?').run(name, req.user.email);
  res.json({ ok: true });
});

// Accesos (solo superadmin)
app.get('/api/users', requireSuper, (_req, res) => res.json(users.listUsers()));
app.post('/api/users', requireSuper, async (req, res) => {
  try { await users.createUser({ ...req.body, mustChange: true }); audit(req.user.email, 'acceso-creado', req.body?.email); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/users/:email', requireSuper, async (req, res) => {
  try { await users.updateUser(req.params.email, req.body || {}); audit(req.user.email, 'acceso-modificado', `${req.params.email} ${Object.keys(req.body || {}).join(',')}`); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/users/:email', requireSuper, (req, res) => {
  try {
    if (req.params.email.toLowerCase() === req.user.email) throw new Error('No podés borrar tu propio acceso.');
    users.deleteUser(req.params.email); audit(req.user.email, 'acceso-borrado', req.params.email); res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/state', (_req, res) => {
  res.json({
    host: state.host,
    docker: state.docker,
    resources: state.resources,
    targets: state.targets,
    updatedAt: state.updatedAt,
    sampleSec: cfg.sampleSec,
  });
});

app.get('/api/history/:name', (req, res) => {
  res.json(history(req.params.name, req.query.hours));
});

app.get('/api/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 40, 200);
  res.json(db.prepare('SELECT ts, level, kind, subject, message FROM events ORDER BY id DESC LIMIT ?').all(limit));
});

app.get('/api/notes', (_req, res) => res.json(pendingNotes()));
app.post('/api/notes/:id/done', requireAdmin, (req, res) => {
  db.prepare('UPDATE notes SET done=1 WHERE id=?').run(Number(req.params.id));
  audit(req.user.email, 'nota-hecha', req.params.id);
  res.json({ ok: true });
});

app.post('/api/briefing', async (req, res) => {
  try { res.json(await briefing(req.user, !!req.body?.force)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/closing/question', (req, res) => res.json({ text: closingQuestion(req.user) }));
app.post('/api/closing/answer', async (req, res) => {
  try {
    const out = await closingAnswer(req.user, req.body?.text);
    audit(req.user.email, 'cierre-jornada', `${out.pendientes.length} pendientes, ${out.manana.length} para mañana`);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/containers/:id/logs', async (req, res) => {
  try {
    res.type('text').send(await docker.containerLogs(req.params.id, req.query.tail));
  } catch (e) { res.status(400).type('text').send(e.message); }
});

app.post('/api/containers/:id/restart', requireAdmin, async (req, res) => {
  try {
    await docker.restartContainer(req.params.id);
    audit(req.user.email, 'reinicio-contenedor', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/audit', requireSuper, (_req, res) => {
  res.json(db.prepare('SELECT ts, user, action, detail FROM audit ORDER BY id DESC LIMIT 100').all());
});

app.get('/api/terminal/pubkey', requireSuper, (_req, res) => res.type('text').send(publicKey()));

app.use('/vendor/xterm', express.static(path.join(root, 'node_modules/@xterm/xterm')));
app.use('/vendor/xterm-fit', express.static(path.join(root, 'node_modules/@xterm/addon-fit')));
app.use(express.static(path.join(root, 'public'), { maxAge: cfg.prod ? '1h' : 0 }));

const server = http.createServer(app);
ensureKey();
attachTerminal(server);
startCollector();

await users.seedUsers();
server.listen(cfg.port, cfg.bindHost, () => console.log(`Estación Puma lista en http://${cfg.bindHost === '0.0.0.0' ? 'localhost' : cfg.bindHost}:${cfg.port}  (Docker: ${cfg.dockerHost})`));
