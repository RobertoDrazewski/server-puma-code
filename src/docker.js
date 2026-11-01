// Cliente mínimo de la API de Docker. En producción habla con el proxy de socket (permisos acotados);
// en tu máquina puede hablar directo con el socket local (unix://...).
import http from 'node:http';
import { cfg } from './config.js';

const idOk = (id) => /^[a-f0-9]{12,64}$/.test(id);

function target() {
  const h = cfg.dockerHost;
  if (h.startsWith('unix://')) return { socketPath: h.slice(7) };
  const u = new URL(h);
  return { hostname: u.hostname, port: u.port || 80 };
}

function request(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...target(), path, method, timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 400) reject(new Error(`Docker ${res.statusCode} en ${path.split('?')[0]}`));
        else resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker: tiempo agotado')));
    req.on('error', (e) => reject(new Error(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? `no se pudo conectar con Docker (${cfg.dockerHost})` : e.message)));
    req.end();
  });
}

export async function listContainers() {
  return JSON.parse(await request('/containers/json?all=1'));
}

export async function containerStats(id) {
  return JSON.parse(await request(`/containers/${id}/stats?stream=false&one-shot=true`));
}

// Los logs de Docker vienen en tramas de 8 bytes de cabecera (si el contenedor no tiene TTY).
function demux(buf) {
  const parts = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    if (type > 2 || buf[i + 1] !== 0 || buf[i + 2] !== 0 || buf[i + 3] !== 0) return buf.toString('utf8');
    const size = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + size).toString('utf8'));
    i += 8 + size;
  }
  return parts.join('');
}

export async function containerLogs(id, tail = 200) {
  if (!idOk(id)) throw new Error('ID inválido');
  const n = Math.min(Math.max(Number(tail) || 200, 10), 1000);
  return demux(await request(`/containers/${id}/logs?stdout=1&stderr=1&tail=${n}`));
}

export async function restartContainer(id) {
  if (!idOk(id)) throw new Error('ID inválido');
  await request(`/containers/${id}/restart?t=10`, 'POST');
}

export { idOk };
