// Terminal web (solo administradores).
// Abre una sesión SSH hacia el servidor con un usuario SIN privilegios (por defecto "estacion"),
// usando una clave propia que se genera sola. Registra en auditoría cada línea ejecutada.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { cfg } from './config.js';
import { identify } from './auth.js';
import { isAdmin } from './users.js';
import { audit } from './db.js';

const keyPath = path.join(cfg.dataDir, 'terminal_key');
const activeUsers = new Set();

export function ensureKey() {
  if (!cfg.terminalEnabled || cfg.terminalMode === 'local') return;
  try {
    if (!fs.existsSync(keyPath)) {
      const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'estacion-puma', '-f', keyPath], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr || 'ssh-keygen falló');
    }
    fs.chmodSync(keyPath, 0o600);
  } catch (e) {
    console.error('Terminal: no se pudo preparar la clave:', e.message);
  }
}

export function publicKey() {
  try { return fs.readFileSync(keyPath + '.pub', 'utf8').trim(); } catch { return ''; }
}

function clean(line) {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
}

export function attachTerminal(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', async (req, socket, head) => {
    if (!req.url?.startsWith('/ws/terminal')) { socket.destroy(); return; }
    const user = await identify(req);
    const origin = req.headers.origin;
    const sameOrigin = !origin || new URL(origin).host === req.headers.host;
    if (!user || !isAdmin(user) || !cfg.terminalEnabled || !sameOrigin) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => run(ws, user));
  });
}

function run(ws, user) {
  if (activeUsers.has(user.email)) {
    ws.send(JSON.stringify({ t: 'o', d: '\r\n\x1b[33mYa tenés una terminal abierta.\x1b[0m\r\n' }));
    ws.close();
    return;
  }
  activeUsers.add(user.email);
  let proc = null;
  let buf = '';
  let idle;
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      ws.send(JSON.stringify({ t: 'o', d: '\r\n\x1b[33mSesión cerrada por inactividad.\x1b[0m\r\n' }));
      ws.close();
    }, cfg.terminalIdleMin * 60e3);
  };

  const start = (cols, rows) => {
    if (cfg.terminalMode === 'local') {
      // Shell de esta misma máquina (modo local). `script` da un pseudo-terminal sin dependencias nativas.
      const linux = process.platform === 'linux';
      proc = spawn('script', linux ? ['-qfc', 'bash -l', '/dev/null'] : ['-q', '/dev/null', process.env.SHELL || 'bash', '-l'], { env: { ...process.env, TERM: 'xterm-256color' }, cwd: process.env.HOME });
      proc.stdin.write(`stty cols ${cols} rows ${rows} 2>/dev/null; clear\n`);
    } else {
      const args = [
        '-tt', '-i', keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `UserKnownHostsFile=${path.join(cfg.dataDir, 'known_hosts')}`, '-o', 'ServerAliveInterval=30',
        `${cfg.terminalUser}@${cfg.terminalHost}`,
        `stty cols ${cols} rows ${rows} 2>/dev/null; exec bash -l`,
      ];
      proc = spawn('ssh', args, { env: { ...process.env, TERM: 'xterm-256color' } });
    }
    audit(user.email, 'terminal-abierta', cfg.terminalMode === 'local' ? 'local' : `${cfg.terminalUser}@${cfg.terminalHost}`);
    const out = (d) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'o', d: d.toString('utf8') }));
    proc.stdout.on('data', out);
    proc.stderr.on('data', out);
    proc.on('error', (e) => { out(`\r\n\x1b[31mNo se pudo iniciar la terminal: ${e.message}\x1b[0m\r\n`); ws.close(); });
    proc.on('close', () => { ws.close(); });
  };

  bump();
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    bump();
    if (m.t === 'init' && !proc) {
      start(Math.min(Math.max(+m.cols || 100, 40), 300), Math.min(Math.max(+m.rows || 30, 10), 100));
    } else if (m.t === 'i' && proc && typeof m.d === 'string') {
      proc.stdin.write(m.d);
      for (const ch of m.d) {
        if (ch === '\r' || ch === '\n') {
          const l = clean(buf);
          if (l) audit(user.email, 'terminal-comando', l);
          buf = '';
        } else if (ch === '\x7f') buf = buf.slice(0, -1);
        else buf += ch;
      }
      if (buf.length > 2000) buf = '';
    }
  });
  ws.on('close', () => {
    clearTimeout(idle);
    activeUsers.delete(user.email);
    audit(user.email, 'terminal-cerrada', '');
    try { proc?.kill('SIGHUP'); } catch { /* ya cerrada */ }
  });
}
