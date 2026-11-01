// Docker simulado para probar la estación en tu Mac sin tocar nada real.
// Responde lo mismo que el proxy de socket: lista de contenedores con etiquetas de Coolify y estadísticas que varían.
import http from 'node:http';

const mk = (id, name, resource, type, host, image = 'node:22', state = 'running') => ({
  Id: id.padEnd(64, '0'), Names: ['/' + name], Image: image, State: state,
  Status: state === 'running' ? 'Up 3 days (healthy)' : 'Exited (1) 2 hours ago',
  Labels: {
    'coolify.managed': 'true', 'coolify.type': type, 'coolify.resourceName': resource, 'coolify.projectName': 'PUMA-CODE',
    ...(host ? { 'traefik.http.routers.r1.rule': 'Host(`' + host + '`) && PathPrefix(`/`)' } : {}),
  },
});

const list = [
  mk('a1f0c2d3e4b5', 'api-kalyber-1', 'kalyber', 'application', 'api.kalyber.com.ar'),
  mk('a1f0c2d3e4b6', 'db-kalyber-1', 'kalyber-mysql', 'database', null, 'mysql:8.4'),
  mk('b2e1d3c4f5a6', 'preciso-1', 'anomalias-preciso.tech', 'application', null),
  mk('b2e1d3c4f5a7', 'db-preciso-1', 'preciso-postgres', 'database', null, 'postgres:17-alpine'),
  mk('c3d2e4f5a6b7', 'mendozapp-1', 'mendozapp.com.ar', 'application', 'api.mendozapp.com.ar'),
  mk('d4c3f5a6b7c8', 'pumacode-1', 'pumacode backend', 'application', 'api2.puma-code.com'),
  mk('e5b4a6b7c8d9', 'agrotech-1', 'agro-tech-puma-code', 'application', 'api.agrotech-pumacode.com.ar'),
  mk('f6a5b7c8d9e0', 'trader-1', 'personal-trader', 'application', null, 'python:3.12', 'exited'),
  mk('0a9b8c7d6e5f', 'coolify', 'coolify', 'application', null, 'coollabsio/coolify:4.5.3'),
  mk('1b8a9c7d6e5f', 'coolify-proxy', 'coolify-proxy', 'application', null, 'traefik:v3.7'),
];
const weight = { a1f0c2d3e4b5: 3.2, a1f0c2d3e4b6: 1.1, b2e1d3c4f5a6: 9.5, b2e1d3c4f5a7: 4, c3d2e4f5a6b7: 0.8, d4c3f5a6b7c8: 0.6, e5b4a6b7c8d9: 1.4, '0a9b8c7d6e5f': 2.2, '1b8a9c7d6e5f': 0.9 };
const cum = {};
const start = Date.now();

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/containers/json') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(list)); }
  let m = u.pathname.match(/^\/containers\/([a-f0-9]+)\/stats$/);
  if (m) {
    const c = list.find((x) => x.Id.startsWith(m[1]));
    const w = weight[m[1].slice(0, 12)] ?? 1;
    const s = cum[c.Id] ||= { cpu: 0, sys: 1e12, rx: 0, tx: 0 };
    const wob = 1 + 0.35 * Math.sin((Date.now() - start) / 9000 + w);
    s.sys += 30e9 * 6; // 30 s * 6 núcleos en ns
    s.cpu += 30e9 * (w * wob / 100);
    s.rx += 40000 * w * wob * 30; s.tx += 22000 * w * wob * 30;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({
      cpu_stats: { cpu_usage: { total_usage: s.cpu }, system_cpu_usage: s.sys, online_cpus: 6 },
      memory_stats: { usage: (120 + w * 90 * wob) * 1048576, stats: { inactive_file: 20 * 1048576 } },
      networks: { eth0: { rx_bytes: s.rx, tx_bytes: s.tx } },
    }));
  }
  m = u.pathname.match(/^\/containers\/([a-f0-9]+)\/logs$/);
  if (m) {
    const lines = Array.from({ length: 25 }, (_, i) => `2026-11-01T12:${String(i).padStart(2, '0')}:00Z GET /api/health 200 ${3 + i}ms\n`).join('');
    return res.end(lines);
  }
  if (req.method === 'POST' && /restart/.test(u.pathname)) { res.statusCode = 204; return res.end(); }
  res.statusCode = 404; res.end('no');
}).listen(2375, () => console.log('Docker simulado en :2375'));
