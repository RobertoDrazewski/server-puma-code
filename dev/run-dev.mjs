// Arranca el Docker simulado y la estación en modo desarrollo (solo para probar en tu máquina).
// Entra como administrador de prueba; en producción esto está deshabilitado.
import { spawn } from 'node:child_process';

const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: process.env.PORT || '3000',
  DOCKER_HOST_URL: 'http://127.0.0.1:2375',
  BOOTSTRAP_PASSWORD: process.env.BOOTSTRAP_PASSWORD || 'demo-demo-1234',
  ADMIN_EMAILS: process.env.ADMIN_EMAILS || 'roberto@example.test',
  VIEWER_EMAILS: process.env.VIEWER_EMAILS || 'mauro@example.test',
  USER_NAMES: process.env.USER_NAMES || 'roberto@example.test:Roberto,mauro@example.test:Mauro',
  SAMPLE_SECONDS: process.env.SAMPLE_SECONDS || '5',
  DATA_DIR: process.env.DATA_DIR || './data-dev',
};

const run = (file) => spawn('node', ['--disable-warning=ExperimentalWarning', file], { stdio: 'inherit', env });
const mock = run('dev/mock-docker.mjs');
const station = run('src/server.js');
const stop = () => { mock.kill(); station.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('\nAbrí http://localhost:' + env.PORT + '  (DEMO con datos simulados)\nEntrá con roberto@example.test / demo-demo-1234\n');
