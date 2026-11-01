// Configuración central. Todo sale de variables de entorno (ver .env.example) o de un archivo .env.
import fs from 'node:fs';
import os from 'node:os';
try { process.loadEnvFile(); } catch { /* no hay .env */ }
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const lower = (v) => list(v).map((s) => s.toLowerCase());

function dockerHost() {
  if (process.env.DOCKER_HOST_URL) return process.env.DOCKER_HOST_URL.replace(/\/$/, '');
  if (process.env.NODE_ENV === 'production') return 'http://socket-proxy:2375';
  // Local (tu Mac/PC): busca el socket real de Docker.
  const home = os.homedir();
  const cands = ['/var/run/docker.sock', `${home}/.docker/run/docker.sock`, `${home}/.colima/default/docker.sock`, `${home}/.orbstack/run/docker.sock`];
  return 'unix://' + (cands.find((c) => fs.existsSync(c)) || cands[0]);
}

const names = {};
for (const pair of list(process.env.USER_NAMES)) {
  const [email, ...n] = pair.split(':');
  if (email && n.length) names[email.trim().toLowerCase()] = n.join(':').trim();
}

export const cfg = {
  port: Number(process.env.PORT) || 3000,
  prod: process.env.NODE_ENV === 'production',
  dataDir: process.env.DATA_DIR || './data',
  dockerHost: dockerHost(),
  bindHost: process.env.BIND_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),

  // Cloudflare Access (opcional: capa extra delante del login propio)
  cfTeamDomain: (process.env.CF_ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
  cfAud: process.env.CF_ACCESS_AUD || '',
  bootstrapPassword: process.env.BOOTSTRAP_PASSWORD || '',
  sessionDays: Number(process.env.SESSION_DAYS) || 7,

  // Roles: admin = todo. viewer = solo ver (métricas, estado, logs).
  admins: lower(process.env.ADMIN_EMAILS),
  viewers: lower(process.env.VIEWER_EMAILS),
  names,

  // Orquestador (OpenAI). Sin clave funciona con textos propios, sin costo.
  openaiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  aiDailyCalls: Number(process.env.AI_DAILY_CALLS) || 20,

  // Muestreo
  sampleSec: Number(process.env.SAMPLE_SECONDS) || 30,
  checkSec: Number(process.env.CHECK_SECONDS) || 60,
  retainDays: Number(process.env.RETAIN_DAYS) || 7,
  extraUrls: list(process.env.EXTRA_URLS),
  groupsFile: process.env.GROUPS_FILE || '',

  // Terminal web (solo admin). Entra por SSH a un usuario sin privilegios del VPS.
  terminalEnabled: process.env.TERMINAL_ENABLED !== '0',
  terminalMode: process.env.TERMINAL_MODE || (process.env.NODE_ENV === 'production' ? 'ssh' : 'local'), // local = shell de esta máquina; ssh = al VPS
  terminalHost: process.env.TERMINAL_HOST || 'host.docker.internal',
  terminalUser: process.env.TERMINAL_USER || 'estacion',
  terminalIdleMin: Number(process.env.TERMINAL_IDLE_MINUTES) || 15,
};

// Cargos y trato por defecto (se pueden cambiar desde Accesos).
export const PROFILES = {
  'drazewski@puma-code.com': { name: 'Roberto Drazewski', call: 'Roberto', title: 'CEO · Super Admin', boss: true },
  'security@puma-code.com': { name: 'Mauro Cannizzo', call: 'Mauro', title: 'Co-Founder & Cybersecurity Chief' },
};

export function displayName(email) {
  if (cfg.names[email]) return cfg.names[email];
  const base = (email || '').split('@')[0].replace(/[._-]+/g, ' ');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

