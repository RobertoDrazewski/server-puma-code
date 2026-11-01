// Recolector: descubre proyectos desde Docker (etiquetas de Coolify), mide consumo,
// revisa que cada dominio responda y genera alertas. Los proyectos nuevos aparecen solos.
import fs from 'node:fs';
import os from 'node:os';
import tls from 'node:tls';
import { cfg } from './config.js';
import { db, now, addEvent, prune } from './db.js';
import * as docker from './docker.js';

export const state = {
  host: null,
  resources: [],
  targets: [],
  updatedAt: 0,
  docker: { ok: false, error: 'iniciando' },
};

const prevC = new Map();   // id contenedor -> última lectura de CPU/red
const spark = new Map();   // recurso -> últimos puntos para el minigráfico
const prevState = new Map();
const targets = new Map(); // url -> estado del chequeo
const certs = new Map();   // host -> días restantes
const cooldown = new Map();
let prevHost = null;
let hostHigh = 0;
let seeded = null;
let groups = {};

function loadGroups() {
  try {
    if (cfg.groupsFile && fs.existsSync(cfg.groupsFile)) groups = JSON.parse(fs.readFileSync(cfg.groupsFile, 'utf8'));
  } catch (e) {
    console.error('groups.json inválido:', e.message);
  }
}

function once(key, ms, fn) {
  const t = Date.now();
  if ((cooldown.get(key) || 0) > t) return;
  cooldown.set(key, t + ms);
  fn();
}

// ---------- Servidor (host) ----------
function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

function readHost() {
  const t = cpuTimes();
  let cpu = 0;
  if (prevHost) {
    const dT = t.total - prevHost.total;
    const dI = t.idle - prevHost.idle;
    cpu = dT > 0 ? Math.max(0, Math.min(100, (1 - dI / dT) * 100)) : 0;
  }
  prevHost = t;
  let disk = { used: 0, total: 0 };
  try {
    const s = fs.statfsSync('/');
    disk = { total: s.blocks * s.bsize, used: (s.blocks - s.bavail) * s.bsize };
  } catch { /* sin datos */ }
  const total = os.totalmem();
  return {
    cpu, cores: os.cpus().length,
    memTotal: total, memUsed: total - os.freemem(),
    load: os.loadavg(), uptime: os.uptime(),
    diskTotal: disk.total, diskUsed: disk.used,
    hostname: os.hostname(),
  };
}

// ---------- Descubrimiento ----------
const DB_IMAGE = /(mysql|mariadb|postgres|redis|mongo|clickhouse|timescale)/i;

function hostsFromLabels(labels) {
  const out = new Set();
  for (const [k, v] of Object.entries(labels || {})) {
    if (!/^traefik\.http\.routers\..+\.rule$/.test(k)) continue;
    for (const m of String(v).matchAll(/Host\(`([^`]+)`\)/g)) out.add(m[1].toLowerCase());
  }
  return out;
}

function familyOf(name) {
  if (groups[name]) return groups[name];
  return name.replace(/[-_ ](mysql|mariadb|postgres|postgresql|db|redis|mongo|database)$/i, '');
}

function describe(c) {
  const labels = c.Labels || {};
  const cname = (c.Names?.[0] || '').replace(/^\//, '');
  const name = labels['coolify.resourceName'] || labels['coolify.name'] || cname || c.Id.slice(0, 12);
  let kind = 'app';
  if (/^coolify/.test(cname) || /^coolify/.test(name) || /^buildx_buildkit/.test(cname) || /^buildx_buildkit/.test(name)) kind = 'sistema';
  else if (labels['coolify.type'] === 'database' || DB_IMAGE.test(c.Image || '')) kind = 'base';
  return { name, kind, project: labels['coolify.projectName'] || '', hosts: hostsFromLabels(labels), cname };
}

async function pool(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

async function sampleContainers() {
  const list = await docker.listContainers();
  const t = Date.now() / 1000;
  const live = list.filter((c) => c.State === 'running');
  const stats = new Map();
  await pool(live, 6, async (c) => {
    try { stats.set(c.Id, await docker.containerStats(c.Id)); } catch { /* sigue con el resto */ }
  });

  const res = new Map();
  for (const c of list) {
    const d = describe(c);
    let r = res.get(d.name);
    if (!r) {
      r = { name: d.name, kind: d.kind, family: familyOf(d.name), project: d.project, hosts: new Set(), containers: [], cpu: 0, mem: 0, rx: 0, tx: 0 };
      res.set(d.name, r);
    }
    for (const h of d.hosts) r.hosts.add(h);
    r.containers.push({
      id: c.Id.slice(0, 12), name: d.cname, state: c.State, status: c.Status,
      healthy: /\(healthy\)/.test(c.Status) ? true : /\(unhealthy\)/.test(c.Status) ? false : null,
      image: (c.Image || '').slice(0, 60),
    });
    const s = stats.get(c.Id);
    if (!s) continue;
    const cpuTotal = s.cpu_stats?.cpu_usage?.total_usage || 0;
    const sys = s.cpu_stats?.system_cpu_usage || 0;
    const cpus = s.cpu_stats?.online_cpus || os.cpus().length;
    let rx = 0, tx = 0;
    for (const n of Object.values(s.networks || {})) { rx += n.rx_bytes || 0; tx += n.tx_bytes || 0; }
    const prev = prevC.get(c.Id);
    let cpuPct = 0, rxRate = 0, txRate = 0;
    if (prev && sys > prev.sys) {
      cpuPct = Math.max(0, ((cpuTotal - prev.cpu) / (sys - prev.sys)) * cpus * 100);
      const dt = Math.max(1, t - prev.t);
      rxRate = Math.max(0, (rx - prev.rx) / dt);
      txRate = Math.max(0, (tx - prev.tx) / dt);
    }
    prevC.set(c.Id, { cpu: cpuTotal, sys, rx, tx, t });
    const m = s.memory_stats || {};
    const mem = Math.max(0, (m.usage || 0) - (m.stats?.inactive_file ?? m.stats?.cache ?? 0));
    r.cpu += cpuPct; r.mem += mem; r.rx += rxRate; r.tx += txRate;
  }
  for (const id of prevC.keys()) if (!list.some((c) => c.Id === id)) prevC.delete(id);
  return res;
}

// ---------- Ciclo principal ----------
async function cycle() {
  const host = readHost();
  const ts = now();
  db.prepare('INSERT INTO host_samples VALUES (?,?,?,?,?,?,?)').run(ts, host.cpu, host.memUsed, host.memTotal, host.load[0], host.diskUsed, host.diskTotal);
  state.host = host;

  let res;
  try {
    res = await sampleContainers();
    if (!state.docker.ok) addEvent('info', 'docker', 'docker', 'Conexión con Docker establecida');
    state.docker = { ok: true, error: '' };
  } catch (e) {
    state.docker = { ok: false, error: e.message };
    once('docker-down', 30 * 60e3, () => addEvent('critical', 'docker', 'docker', `Sin conexión con Docker: ${e.message}`));
    state.updatedAt = Date.now();
    return;
  }

  if (seeded === null) seeded = db.prepare('SELECT COUNT(*) c FROM known').get().c > 0;
  const ins = db.prepare('INSERT INTO samples VALUES (?,?,?,?,?,?)');
  const list = [];
  for (const r of res.values()) {
    const running = r.containers.filter((c) => c.state === 'running').length;
    r.status = running === r.containers.length ? 'running' : running === 0 ? 'exited' : 'degraded';
    r.healthy = r.containers.some((c) => c.healthy === false) ? false : r.containers.some((c) => c.healthy === true) ? true : null;
    r.hosts = [...r.hosts];
    if (!db.prepare('SELECT 1 FROM known WHERE name=?').get(r.name)) {
      db.prepare('INSERT INTO known VALUES (?,?)').run(r.name, ts);
      if (seeded && r.kind !== 'sistema') addEvent('info', 'nuevo', r.name, `Proyecto nuevo detectado: ${r.name}`);
    }
    const before = prevState.get(r.name);
    if (before === 'running' && r.status !== 'running') addEvent('critical', 'caido', r.name, `${r.name} dejó de correr (${r.status})`);
    if (before && before !== 'running' && r.status === 'running') addEvent('info', 'recuperado', r.name, `${r.name} volvió a correr`);
    prevState.set(r.name, r.status);

    ins.run(ts, r.name, r.cpu, r.mem, r.rx, r.tx);
    const sp = spark.get(r.name) || { cpu: [], mem: [] };
    sp.cpu.push(Math.round(r.cpu * 10) / 10); sp.mem.push(r.mem);
    if (sp.cpu.length > 60) { sp.cpu.shift(); sp.mem.shift(); }
    spark.set(r.name, sp);
    r.spark = sp;
    list.push(r);
  }
  for (const [name] of prevState) if (!res.has(name)) {
    if (prevState.get(name) !== 'gone') addEvent('warn', 'quitado', name, `${name} ya no existe en el servidor`);
    prevState.set(name, 'gone');
  }

  // Alertas del servidor
  hostHigh = host.cpu > 90 ? hostHigh + 1 : 0;
  if (hostHigh >= 10) once('host-cpu', 30 * 60e3, () => addEvent('warn', 'cpu', 'servidor', `CPU del servidor sobre 90% sostenida (${host.cpu.toFixed(0)}%)`));
  if (host.memTotal && host.memUsed / host.memTotal > 0.9) once('host-mem', 30 * 60e3, () => addEvent('warn', 'ram', 'servidor', 'Memoria del servidor sobre 90%'));
  if (host.diskTotal && host.diskUsed / host.diskTotal > 0.85) once('host-disk', 6 * 3600e3, () => addEvent('warn', 'disco', 'servidor', `Disco al ${Math.round((host.diskUsed / host.diskTotal) * 100)}%`));

  state.resources = list;
  syncTargets(list);
  attachTargets();
  state.updatedAt = Date.now();
}

// ---------- Estado en línea (HTTP) ----------
function syncTargets(list) {
  const want = new Map();
  for (const r of list) {
    if (r.kind === 'sistema') continue;
    for (const h of r.hosts) want.set(`https://${h}/`, r.name);
  }
  for (const item of cfg.extraUrls) {
    // Formato: "https://sitio.com" o "proyecto=https://sitio.com" (lo asocia al reloj de ese proyecto)
    const m = item.match(/^([^=/:]+)=(.+)$/);
    const [owner, u] = m ? [m[1].trim(), m[2].trim()] : ['externo', item];
    const url = /^https?:\/\//.test(u) ? u : `https://${u}`;
    try { new URL(url); } catch { continue; }
    if (!want.has(url)) want.set(url, owner);
  }
  for (const [url, owner] of want) {
    if (!targets.has(url)) targets.set(url, { url, owner, host: new URL(url).hostname, ok: null, ms: null, status: null, fails: 0, up24: null, avgMs: null, checkedAt: 0 });
    targets.get(url).owner = owner;
  }
  for (const url of targets.keys()) if (!want.has(url)) targets.delete(url);
}

async function checkOne(t) {
  const t0 = Date.now();
  let ok = false, status = 0;
  try {
    const r = await fetch(t.url, { redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'PumaStation/1.0 (+uptime)' } });
    status = r.status;
    ok = r.status < 500; // 404 de una API sin ruta raíz sigue siendo "en línea"
    await r.body?.cancel?.();
  } catch { ok = false; }
  const ms = Date.now() - t0;
  db.prepare('INSERT INTO checks VALUES (?,?,?,?,?)').run(now(), t.url, ok ? 1 : 0, ms, status);
  const was = t.ok;
  t.fails = ok ? 0 : t.fails + 1;
  t.ok = ok; t.ms = ms; t.status = status; t.checkedAt = Date.now();
  if (!ok && t.fails === 2) addEvent('critical', 'sitio-caido', t.owner, `${t.host} no responde (${status || 'sin conexión'})`);
  if (ok && was === false) addEvent('info', 'sitio-ok', t.owner, `${t.host} volvió a responder`);
  const row = db.prepare('SELECT AVG(ok) a, AVG(ms) m FROM checks WHERE target=? AND ts>?').get(t.url, now() - 86400);
  t.up24 = row.a == null ? null : Math.round(row.a * 1000) / 10;
  t.avgMs = row.m == null ? null : Math.round(row.m);
}

function certDays(host) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 8000 }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c?.valid_to ? Math.floor((new Date(c.valid_to) - Date.now()) / 86400e3) : null);
    });
    s.on('error', () => resolve(null));
    s.on('timeout', () => { s.destroy(); resolve(null); });
  });
}

async function checkCerts() {
  for (const t of targets.values()) {
    if (!t.url.startsWith('https://')) continue;
    const d = await certDays(t.host);
    certs.set(t.host, d);
    if (d != null && d < 14) once(`cert-${t.host}`, 24 * 3600e3, () => addEvent('warn', 'certificado', t.owner, `El certificado de ${t.host} vence en ${d} días`));
  }
}

async function checkAll() {
  await pool([...targets.values()], 6, checkOne);
  attachTargets();
}

function attachTargets() {
  const all = [...targets.values()].map((t) => ({ ...t, certDays: certs.get(t.host) ?? null }));
  state.targets = all;
  for (const r of state.resources) {
    const mine = all.filter((t) => t.owner === r.name);
    r.sites = mine;
    r.online = mine.length ? mine.every((t) => t.ok !== false) && mine.some((t) => t.ok === true) ? true : mine.some((t) => t.ok === false) ? false : null : null;
  }
}

// ---------- Historial ----------
export function history(name, hours = 24) {
  const h = Math.min(Math.max(Number(hours) || 24, 1), cfg.retainDays * 24);
  const bucket = Math.max(30, Math.floor((h * 3600) / 120));
  const since = now() - h * 3600;
  const rows = name === '__host__'
    ? db.prepare('SELECT (ts/?)*? b, AVG(cpu) cpu, AVG(mem_used) mem, AVG(load1) load FROM host_samples WHERE ts>? GROUP BY b ORDER BY b').all(bucket, bucket, since)
    : db.prepare('SELECT (ts/?)*? b, AVG(cpu) cpu, AVG(mem) mem, AVG(rx) rx, AVG(tx) tx FROM samples WHERE name=? AND ts>? GROUP BY b ORDER BY b').all(bucket, bucket, name, since);
  return rows;
}

export function startCollector() {
  loadGroups();
  const run = () => cycle().catch((e) => console.error('ciclo:', e.message));
  run();
  setInterval(run, cfg.sampleSec * 1000);
  setTimeout(() => { checkAll().catch(() => {}); checkCerts().catch(() => {}); }, 8000);
  setInterval(() => checkAll().catch(() => {}), cfg.checkSec * 1000);
  setInterval(() => checkCerts().catch(() => {}), 3600e3);
  setInterval(() => { try { prune(); } catch (e) { console.error('prune:', e.message); } }, 3600e3);
}
