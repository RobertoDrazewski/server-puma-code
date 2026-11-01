// Autenticación: login propio (usuarios + cookie de sesión). Opcionalmente, y como capa extra,
// exige el JWT de Cloudflare Access si están definidos CF_ACCESS_TEAM_DOMAIN y CF_ACCESS_AUD.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { cfg } from './config.js';
import { userFromToken, isAdmin } from './users.js';

export const COOKIE = 'ep_session';
const cfOn = () => !!(cfg.cfTeamDomain && cfg.cfAud);

let jwks = null;
const getJwks = () => (jwks ||= createRemoteJWKSet(new URL(`https://${cfg.cfTeamDomain}/cdn-cgi/access/certs`)));

export function cookieValue(header, name) {
  for (const part of (header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

export async function cfAllowed(req) {
  if (!cfOn()) return true;
  const token = req.headers['cf-access-jwt-assertion'] || cookieValue(req.headers.cookie, 'CF_Authorization');
  if (!token) return false;
  try {
    await jwtVerify(token, getJwks(), { issuer: `https://${cfg.cfTeamDomain}`, audience: cfg.cfAud });
    return true;
  } catch { return false; }
}

export async function identify(req) {
  if (!(await cfAllowed(req))) return null;
  return userFromToken(cookieValue(req.headers.cookie, COOKIE));
}

export async function cfGate(req, res, next) {
  if (await cfAllowed(req)) return next();
  res.status(401).type('text').send('No autorizado');
}

const OPEN_WHEN_MUST_CHANGE = new Set(['/me', '/me/password', '/auth/logout']);
export async function requireUser(req, res, next) {
  const user = await identify(req);
  if (!user) return res.status(401).json({ error: 'sesion' });
  if (user.mustChange && !OPEN_WHEN_MUST_CHANGE.has(req.path)) return res.status(403).json({ error: 'cambiar-clave' });
  req.user = user;
  next();
}
export function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Solo administradores' });
  next();
}
export function requireSuper(req, res, next) {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'Solo el superadmin' });
  next();
}
