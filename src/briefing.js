// Orquestador: arma el informe de bienvenida y el cierre de jornada.
// Usa OpenAI solo si hay clave, con un modelo chico, respuestas cortas y un tope diario.
// Sin clave (o si falla) usa textos propios: la estación funciona igual y sin costo.
import { cfg } from './config.js';
import { db, now } from './db.js';
import { state } from './collector.js';

const TZ = 'America/Argentina/Mendoza';

function localParts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
const today = () => localParts().day;
const tomorrow = () => localParts(new Date(Date.now() + 86400e3)).day;
function greeting() {
  const h = localParts().hour;
  return h < 6 ? 'Buenas noches' : h < 13 ? 'Buen día' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
}

// ---------- IA (opcional) ----------
async function ai(messages, { json = false, max = 260 } = {}) {
  if (!cfg.openaiKey) return null;
  const day = new Date().toISOString().slice(0, 10);
  const used = db.prepare('SELECT calls FROM ai_usage WHERE day=?').get(day)?.calls || 0;
  if (used >= cfg.aiDailyCalls) return null;
  db.prepare('INSERT INTO ai_usage (day, calls) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1').run(day);
  try {
    const body = { model: cfg.openaiModel, messages, max_completion_tokens: max };
    if (json) body.response_format = { type: 'json_object' };
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.openaiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('IA:', e.message);
    return null;
  }
}

export function aiStatus() {
  const day = new Date().toISOString().slice(0, 10);
  const used = db.prepare('SELECT calls FROM ai_usage WHERE day=?').get(day)?.calls || 0;
  return { enabled: !!cfg.openaiKey, model: cfg.openaiKey ? cfg.openaiModel : null, used, cap: cfg.aiDailyCalls };
}

// ---------- Datos ----------
export function pendingNotes() {
  return db.prepare('SELECT id, ts, user, kind, text, due FROM notes WHERE done=0 AND (due IS NULL OR due <= ?) ORDER BY id DESC LIMIT 20').all(today());
}

export function buildFacts(user) {
  const h = state.host;
  const apps = state.resources.filter((r) => r.kind !== 'sistema');
  const last = db.prepare("SELECT ts FROM sessions WHERE user=? AND kind='cierre' ORDER BY id DESC LIMIT 1").get(user.email)?.ts;
  const since = last || now() - 86400;
  const events = db.prepare("SELECT ts, level, message FROM events WHERE ts>? AND kind NOT IN ('docker') ORDER BY id DESC LIMIT 8").all(since);
  const sitesDown = state.targets.filter((t) => t.ok === false).map((t) => t.host);
  const certs = state.targets.filter((t) => t.certDays != null && t.certDays < 14).map((t) => `${t.host} (${t.certDays} días)`);
  const byCpu = [...apps].sort((a, b) => b.cpu - a.cpu).slice(0, 3).map((r) => ({ nombre: r.name, cpu: Math.round(r.cpu * 10) / 10 }));
  const byMem = [...apps].sort((a, b) => b.mem - a.mem).slice(0, 3).map((r) => ({ nombre: r.name, ram_mb: Math.round(r.mem / 1048576) }));
  return {
    usuario: user.name,
    franja: greeting(),
    docker: state.docker.ok ? 'conectado' : `sin conexión (${state.docker.error})`,
    servidor: h ? {
      cpu_pct: Math.round(h.cpu),
      ram_pct: h.memTotal ? Math.round((h.memUsed / h.memTotal) * 100) : null,
      disco_pct: h.diskTotal ? Math.round((h.diskUsed / h.diskTotal) * 100) : null,
      carga: Math.round(h.load[0] * 100) / 100,
      nucleos: h.cores,
      dias_encendido: Math.floor(h.uptime / 86400),
    } : null,
    proyectos: {
      total: apps.length,
      corriendo: apps.filter((r) => r.status === 'running').length,
      caidos: apps.filter((r) => r.status !== 'running').map((r) => r.name),
    },
    sitios_sin_respuesta: sitesDown,
    certificados_por_vencer: certs,
    mayor_consumo_cpu: byCpu,
    mayor_consumo_ram: byMem,
    novedades_desde_ultima_vez: events.map((e) => e.message),
    pendientes: pendingNotes().map((n) => n.text),
  };
}

function template(f) {
  const parts = [`${f.franja}, ${f.usuario}.`];
  if (!f.servidor) return `${parts[0]} Todavía estoy tomando las primeras lecturas del servidor.`;
  const p = f.proyectos;
  if (f.docker !== 'conectado') parts.push('No logro conectarme con Docker, revisá el proxy de socket.');
  if (p.caidos.length) parts.push(`Atención: ${p.caidos.length === 1 ? 'no está corriendo' : 'no están corriendo'} ${p.caidos.join(', ')}.`);
  if (f.sitios_sin_respuesta.length) parts.push(`Sin respuesta web: ${f.sitios_sin_respuesta.join(', ')}.`);
  if (!p.caidos.length && !f.sitios_sin_respuesta.length) parts.push(`Los ${p.total} proyectos están en línea.`);
  const s = f.servidor;
  parts.push(`El servidor está con ${s.cpu_pct}% de procesador, ${s.ram_pct}% de memoria y ${s.disco_pct}% de disco.`);
  if (f.mayor_consumo_cpu[0]) parts.push(`El que más consume es ${f.mayor_consumo_cpu[0].nombre}.`);
  if (f.certificados_por_vencer.length) parts.push(`Ojo con certificados por vencer: ${f.certificados_por_vencer.join(', ')}.`);
  if (f.novedades_desde_ultima_vez.length) parts.push(`Desde tu última visita hubo ${f.novedades_desde_ultima_vez.length} novedades; las ves en el registro.`);
  if (f.pendientes.length) parts.push(`Tenés ${f.pendientes.length} ${f.pendientes.length === 1 ? 'pendiente' : 'pendientes'}: ${f.pendientes.slice(0, 3).join('; ')}.`);
  return parts.join(' ');
}

const cache = new Map();
export async function briefing(user, force = false) {
  const hit = cache.get(user.email);
  if (!force && hit && Date.now() - hit.t < 10 * 60e3) return hit.out;
  const facts = buildFacts(user);
  let text = await ai([
    { role: 'system', content: 'Sos el ingeniero de a bordo de la Estación Puma, el panel del servidor de Puma Code. Hablás en español rioplatense, tono profesional y cercano, con frases cortas pensadas para leerse en voz alta. Máximo 90 palabras. Sin listas, sin emojis, sin markdown. Usá solo los datos recibidos y no inventes nada. Empezá saludando por el nombre según la franja horaria. Si hay problemas, mencionalos primero. Si hay pendientes, cerrá recordándolos.' },
    { role: 'user', content: JSON.stringify(facts) },
  ]);
  const usedAi = !!text;
  if (!text) text = template(facts);
  const out = { text, ai: usedAi, facts };
  cache.set(user.email, { t: Date.now(), out });
  db.prepare("INSERT INTO sessions (ts, user, kind, summary) VALUES (?,?,?,?)").run(now(), user.email, 'apertura', text.slice(0, 400));
  return out;
}

// ---------- Cierre de jornada ----------
export function closingQuestion(user) {
  return `${user.name}, antes de apagar: ¿quedó todo en orden? ¿Dejás algo pendiente o querés que te agende algún trabajo para mañana?`;
}

const NOTHING = /^\s*(no|nada|todo (bien|ok|en orden)|ok|listo|sin pendientes|no,? (nada|gracias)|está todo bien)[\s.!]*$/i;

export async function closingAnswer(user, text) {
  const clean = String(text || '').trim().slice(0, 1500);
  const ins = db.prepare('INSERT INTO notes (ts, user, kind, text, due) VALUES (?,?,?,?,?)');
  let pend = [], man = [], resumen = '';
  if (clean && !NOTHING.test(clean)) {
    const raw = await ai([
      { role: 'system', content: 'Extraé del mensaje del usuario una lista de cosas que quedaron pendientes y una lista de trabajos para agendar mañana. Respondé solo JSON con esta forma: {"resumen":"una frase","pendientes":["texto corto"],"manana":["texto corto"]}. Si no hay, listas vacías. No inventes tareas.' },
      { role: 'user', content: clean },
    ], { json: true, max: 300 });
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { /* usa el texto tal cual */ }
    if (parsed) {
      pend = (parsed.pendientes || []).map(String).filter(Boolean).slice(0, 8);
      man = (parsed.manana || []).map(String).filter(Boolean).slice(0, 8);
      resumen = String(parsed.resumen || '');
    } else {
      pend = [clean.slice(0, 300)];
    }
    for (const t of pend) ins.run(now(), user.email, 'pendiente', t, null);
    for (const t of man) ins.run(now(), user.email, 'manana', t, tomorrow());
  }
  db.prepare("INSERT INTO sessions (ts, user, kind, summary) VALUES (?,?,?,?)").run(now(), user.email, 'cierre', resumen || clean.slice(0, 300) || 'Todo en orden');
  const bits = [];
  if (pend.length) bits.push(`dejé anotado ${pend.length === 1 ? 'un pendiente' : pend.length + ' pendientes'}`);
  if (man.length) bits.push(`agendé ${man.length === 1 ? 'un trabajo' : man.length + ' trabajos'} para mañana`);
  const reply = bits.length ? `Perfecto, ${bits.join(' y ')}. Te lo recuerdo apenas enciendas la estación. Hasta pronto, ${user.name}.` : `Entendido, todo en orden. Hasta pronto, ${user.name}.`;
  return { reply, pendientes: pend, manana: man };
}
