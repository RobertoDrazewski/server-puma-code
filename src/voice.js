// Voz de Puma: convierte texto en audio con OpenAI TTS.
// Cuida el gasto: tope diario de caracteres, texto máximo por pedido y caché de lo ya dicho.
// Si no hay clave, se superó el tope o algo falla, devuelve null y el panel usa la voz del navegador (gratis).
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { db } from './db.js';

const MAX_CHARS = 1200;
const INSTRUCCIONES = 'Sos Puma, el orquestador de una estación steampunk de Puma Code. Hablá en español rioplatense de Argentina, '
  + 'con voseo natural y acento argentino. Voz cálida, segura y cercana, con ritmo fluido y pausas breves entre ideas. '
  + 'Hablá con ritmo ágil y dinámico, algo más rápido que lo habitual, sin arrastrar las palabras ni hacer pausas largas. '
  + 'Sonás como una persona real conversando, no como un locutor ni un robot.';

const cache = new Map(); // clave -> Buffer (se conservan los últimos 12)

export const voiceEnabled = () => !!cfg.openaiKey && cfg.ttsDailyChars > 0;

function usedToday() {
  const day = new Date().toISOString().slice(0, 10) + ':tts';
  return { day, used: db.prepare('SELECT calls FROM ai_usage WHERE day=?').get(day)?.calls || 0 };
}

export function voiceStatus() {
  return { enabled: voiceEnabled(), model: cfg.ttsModel, voice: cfg.ttsVoice, usedChars: usedToday().used, capChars: cfg.ttsDailyChars };
}

export async function synthesize(text) {
  if (!voiceEnabled()) return null;
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  if (!text) return null;
  const key = crypto.createHash('sha1').update(`${cfg.ttsModel}|${cfg.ttsVoice}|${text}`).digest('hex');
  if (cache.has(key)) return cache.get(key); // repetir algo ya dicho no cuesta nada
  const { day, used } = usedToday();
  if (used + text.length > cfg.ttsDailyChars) return null;
  db.prepare('INSERT INTO ai_usage (day, calls) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET calls = calls + ?').run(day, text.length, text.length);
  try {
    const body = { model: cfg.ttsModel, voice: cfg.ttsVoice, input: text, response_format: 'mp3' };
    if (/gpt-4o/.test(cfg.ttsModel)) body.instructions = INSTRUCCIONES;
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.openaiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error(`OpenAI TTS ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    cache.set(key, buf);
    if (cache.size > 12) cache.delete(cache.keys().next().value);
    return buf;
  } catch (e) {
    console.error('Voz:', e.message);
    return null;
  }
}
