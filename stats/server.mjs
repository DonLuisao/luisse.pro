// Servicio de estadísticas de luisse.pro. Corre en la Raspberry Pi, detrás de Caddy.
//
//   GET  /api/status   temperatura de la CPU, tiempo encendida y visitas de los últimos 30 días
//   GET  /api/homelab  estado de los servicios, sacado de una página de estado de Uptime Kuma
//   POST /api/hit            suma una visita a una página
//   POST /api/download       suma una descarga del CV en PDF
//   GET  /api/estadisticas   datos del panel privado (solo con Cloudflare Access, ver abajo)
//   GET  /api/health         para comprobar que el servicio está vivo
//
// Además, cada lunes a las 9:00 (hora de Madrid) manda por correo un resumen de la semana,
// si están RESEND_API_KEY y REPORT_TO. Para probarlo sin esperar al lunes, desde la Pi:
//   docker compose exec stats wget -qO- --post-data= http://127.0.0.1:8080/api/resumen/prueba
//
// Privacidad: por cada visita solo se guardan, sumados en contadores por día, la página, el
// idioma, el país (lo pone Cloudflare), el dominio desde el que se llega (linkedin.com, sin
// la dirección completa) y si es móvil u ordenador. No hay cookies, ni IPs, ni nada que
// permita distinguir a una persona de otra.
//
// Sin dependencias: usa el SQLite que trae Node.
import { createServer } from 'node:http';
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? '/data/stats.db';
const THERMAL_PATH = process.env.THERMAL_PATH ?? '/sys/class/thermal/thermal_zone0/temp';
const UPTIME_PATH = process.env.UPTIME_PATH ?? '/proc/uptime';
// Tope de visitas que se aceptan por minuto entre todos los visitantes, para que nadie
// pueda inflar el contador a base de peticiones.
const MAX_HITS_PER_MINUTE = Number(process.env.MAX_HITS_PER_MINUTE ?? 120);

// Uptime Kuma: dirección dentro de la red y nombre (slug) de su página de estado.
// Sin estas dos variables, /api/homelab responde que no hay estado y la página no lo muestra.
const KUMA_URL = (process.env.KUMA_URL ?? '').replace(/\/+$/, '');
const KUMA_SLUG = process.env.KUMA_SLUG ?? '';

// Panel privado: Cloudflare Access protege /api/estadisticas y firma cada petición con un
// token (cabecera Cf-Access-Jwt-Assertion) que aquí se comprueba con las claves públicas del
// equipo de Cloudflare Zero Trust. Sin ACCESS_TEAM y ACCESS_AUD, el panel está desactivado.
const ACCESS_TEAM = process.env.ACCESS_TEAM ?? ''; // p. ej. "luisse" de luisse.cloudflareaccess.com
const ACCESS_AUD = process.env.ACCESS_AUD ?? ''; // "Application Audience (AUD) Tag" de la aplicación
const ACCESS_CERTS_URL = process.env.ACCESS_CERTS_URL ?? `https://${ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`;
const ACCESS_ISSUER = process.env.ACCESS_ISSUER ?? `https://${ACCESS_TEAM}.cloudflareaccess.com`;

// Resumen semanal por correo (con Resend, desde el subdominio de envío)
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? '';
const RESEND_URL = process.env.RESEND_URL ?? 'https://api.resend.com/emails';
const REPORT_TO = process.env.REPORT_TO ?? '';
const REPORT_FROM = process.env.REPORT_FROM ?? 'luisse.pro <estadisticas@envio.luisse.pro>';
const REPORT_TZ = 'Europe/Madrid';

const PAGES = new Set(['/', '/en/', '/homelab/', '/en/homelab/']);
const LANGS = new Set(['es', 'en']);
const DEVICES = new Set(['mobile', 'desktop']);

// Segunda barrera contra visitas que no son de personas (la primera está en la web,
// src/scripts/visitas.ts). Se descartan sin avisar: la respuesta es la misma.
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS ?? 'https://luisse.pro').split(',').map((o) => o.trim()));
const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|preview|headless|lighthouse|pagespeed|ptst|inspectiontool|facebookexternalhit|whatsapp|telegram|discord|embedly|skype|curl|wget|python|httpclient|phantom|puppeteer|playwright|selenium|go-http|okhttp|java\//i;

function looksHuman(req) {
  const ua = String(req.headers['user-agent'] ?? '');
  if (!ua || BOT_UA.test(ua)) return false;
  // Los navegadores siempre mandan su idioma; la mayoría de scripts y bots, no
  if (!/[a-z]{2}/i.test(String(req.headers['accept-language'] ?? ''))) return false;
  // sendBeacon manda Origin: solo valen las peticiones hechas desde la propia web
  return ALLOWED_ORIGINS.has(String(req.headers.origin ?? ''));
}

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS visits (
    day   TEXT    NOT NULL,
    path  TEXT    NOT NULL,
    lang  TEXT    NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, path, lang)
  ) WITHOUT ROWID;
`);
const addVisit = db.prepare(`
  INSERT INTO visits (day, path, lang, count) VALUES (?, ?, ?, 1)
  ON CONFLICT (day, path, lang) DO UPDATE SET count = count + 1
`);
const visitsSince = db.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM visits WHERE day >= ?');

// Desglose para el panel privado. La tabla visits sigue siendo la del contador público;
// esta guarda además país, origen y dispositivo (empezó a llenarse más tarde que visits).
db.exec(`
  CREATE TABLE IF NOT EXISTS details (
    day     TEXT    NOT NULL,
    path    TEXT    NOT NULL,
    country TEXT    NOT NULL,
    source  TEXT    NOT NULL,
    device  TEXT    NOT NULL,
    count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, path, country, source, device)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS downloads (
    day   TEXT    NOT NULL,
    lang  TEXT    NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, lang)
  ) WITHOUT ROWID;
`);
db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;');
const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');

const addDetail = db.prepare(`
  INSERT INTO details (day, path, country, source, device, count) VALUES (?, ?, ?, ?, ?, 1)
  ON CONFLICT (day, path, country, source, device) DO UPDATE SET count = count + 1
`);
const addDownload = db.prepare(`
  INSERT INTO downloads (day, lang, count) VALUES (?, ?, 1)
  ON CONFLICT (day, lang) DO UPDATE SET count = count + 1
`);

// País: Cloudflare lo manda en CF-IPCountry (dos letras; XX si no lo sabe, T1 si es Tor).
function countryOf(req) {
  const c = String(req.headers['cf-ipcountry'] ?? '').toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : '';
}

// Origen: solo el dominio, sin www. Vacío si se entra directamente o desde la propia web.
function sourceOf(ref) {
  if (typeof ref !== 'string' || !ref) return '';
  const host = ref.toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9.-]{1,100}$/.test(host) || !host.includes('.')) return '';
  if (host === 'luisse.pro' || host.endsWith('.luisse.pro')) return '';
  return host;
}

const isoDay = (date) => date.toISOString().slice(0, 10);

async function readNumber(path) {
  try {
    const value = Number.parseFloat((await readFile(path, 'utf8')).trim().split(/\s+/)[0]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

// La respuesta de /api/status se guarda 30 segundos: no hace falta leer el sistema
// ni la base de datos en cada visita.
let cached = { at: 0, body: '' };

async function status() {
  if (Date.now() - cached.at < 30_000) return cached.body;
  const millidegrees = await readNumber(THERMAL_PATH);
  const uptime = await readNumber(UPTIME_PATH);
  const since = isoDay(new Date(Date.now() - 29 * 86_400_000));
  const body = JSON.stringify({
    cpu_temp_c: millidegrees === null ? null : Math.round(millidegrees / 100) / 10,
    uptime_s: uptime === null ? null : Math.floor(uptime),
    visits_30d: Number(visitsSince.get(since).total),
  });
  cached = { at: Date.now(), body };
  return body;
}

// Estado de los servicios desde Uptime Kuma. Solo se publica el nombre de cada monitor,
// si funciona y su disponibilidad en 24 horas: nada de direcciones, mensajes de error ni tiempos.
// Se guarda un minuto, que es lo que tarda Uptime Kuma en volver a comprobar.
const KUMA_STATUS = { 0: 'down', 1: 'up', 2: 'pending', 3: 'maintenance' };
let kumaCache = { at: 0, ttl: 0, body: '' };

async function kumaJson(path) {
  const res = await fetch(`${KUMA_URL}${path}`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`Uptime Kuma respondió ${res.status} en ${path}`);
  return res.json();
}

async function homelab() {
  if (Date.now() - kumaCache.at < kumaCache.ttl) return kumaCache.body;
  let body;
  let ttl = 60_000;
  if (!KUMA_URL || !KUMA_SLUG) {
    body = JSON.stringify({ configured: false });
    ttl = 10 * 60_000;
  } else {
    try {
      const slug = encodeURIComponent(KUMA_SLUG);
      const [page, beats] = await Promise.all([
        kumaJson(`/api/status-page/${slug}`),
        kumaJson(`/api/status-page/heartbeat/${slug}`),
      ]);
      const monitors = {};
      for (const group of page.publicGroupList ?? []) {
        for (const m of group.monitorList ?? []) {
          const list = beats.heartbeatList?.[m.id] ?? [];
          const last = list.at(-1);
          const uptime = beats.uptimeList?.[`${m.id}_24`];
          monitors[m.name] = {
            status: KUMA_STATUS[last?.status] ?? 'pending',
            uptime_24h: typeof uptime === 'number' ? Math.round(uptime * 10000) / 10000 : null,
          };
        }
      }
      body = JSON.stringify({ configured: true, checked_at: new Date().toISOString(), monitors });
    } catch (error) {
      console.error('No se ha podido leer Uptime Kuma:', error.message);
      body = JSON.stringify({ configured: true, error: true });
      ttl = 30_000;
    }
  }
  kumaCache = { at: Date.now(), ttl, body };
  return body;
}

// ---- Panel privado ----

// Comprueba el token de Cloudflare Access (RS256). Las claves públicas se guardan una hora.
let accessKeys = { at: 0, keys: new Map() };

async function loadAccessKeys(force = false) {
  if (!force && Date.now() - accessKeys.at < 3_600_000) return accessKeys.keys;
  const res = await fetch(ACCESS_CERTS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Claves de Cloudflare Access: ${res.status}`);
  const { keys = [] } = await res.json();
  accessKeys = { at: Date.now(), keys: new Map(keys.map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })])) };
  return accessKeys.keys;
}

const b64 = (s) => Buffer.from(s, 'base64url');

async function accessAllowed(req) {
  if (!ACCESS_TEAM || !ACCESS_AUD) return false;
  const token = String(req.headers['cf-access-jwt-assertion'] ?? '');
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return false;
  let header;
  let payload;
  try {
    header = JSON.parse(b64(h));
    payload = JSON.parse(b64(p));
  } catch {
    return false;
  }
  if (header.alg !== 'RS256') return false;
  let keys = await loadAccessKeys();
  if (!keys.has(header.kid)) keys = await loadAccessKeys(true);
  const key = keys.get(header.kid);
  if (!key || !verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, b64(sig))) return false;
  const now = Date.now() / 1000;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return aud.includes(ACCESS_AUD) && payload.iss === ACCESS_ISSUER && typeof payload.exp === 'number' && payload.exp > now;
}

const PERIODS = new Set([7, 30, 90, 365]);

function stats(days) {
  const from = isoDay(new Date(Date.now() - (days - 1) * 86_400_000));
  const all = (sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r }));
  const one = (sql, ...args) => Number(db.prepare(sql).get(...args).total);
  const group = (column) =>
    all(`SELECT ${column} AS key, SUM(count) AS count FROM details WHERE day >= ? GROUP BY ${column} ORDER BY count DESC LIMIT 25`, from);
  return {
    from,
    to: isoDay(new Date()),
    visits: one('SELECT COALESCE(SUM(count), 0) AS total FROM visits WHERE day >= ?', from),
    by_day: all('SELECT day, SUM(count) AS count FROM visits WHERE day >= ? GROUP BY day ORDER BY day', from),
    pages: all('SELECT path AS key, SUM(count) AS count FROM visits WHERE day >= ? GROUP BY path ORDER BY count DESC', from),
    langs: all('SELECT lang AS key, SUM(count) AS count FROM visits WHERE day >= ? GROUP BY lang ORDER BY count DESC', from),
    // País, origen y dispositivo solo existen desde que se añadió el panel
    detailed: one('SELECT COALESCE(SUM(count), 0) AS total FROM details WHERE day >= ?', from),
    details_since: db.prepare('SELECT MIN(day) AS day FROM details').get().day ?? null,
    countries: group('country'),
    sources: group('source'),
    devices: group('device'),
    downloads: one('SELECT COALESCE(SUM(count), 0) AS total FROM downloads WHERE day >= ?', from),
    downloads_by_lang: all('SELECT lang AS key, SUM(count) AS count FROM downloads WHERE day >= ? GROUP BY lang ORDER BY count DESC', from),
  };
}

// ---- Resumen semanal ----

const PAGE_NAMES = { '/': 'CV en español', '/en/': 'CV en inglés', '/homelab/': 'Homelab en español', '/en/homelab/': 'Homelab en inglés' };
const DEVICE_NAMES = { mobile: 'Móvil', desktop: 'Ordenador', '': 'Sin datos' };
const regionName = new Intl.DisplayNames(['es'], { type: 'region' });
const fmtDay = new Intl.DateTimeFormat('es', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtLong = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Los 7 días que terminan ayer (hora UTC, como el resto de contadores)
export function weekReport(now = new Date()) {
  const day = (offset) => isoDay(new Date(now.getTime() - offset * 86_400_000));
  const from = day(7);
  const to = day(1);
  const prevFrom = day(14);
  const prevTo = day(8);
  const sum = (table, a, b) => Number(db.prepare(`SELECT COALESCE(SUM(count), 0) AS total FROM ${table} WHERE day BETWEEN ? AND ?`).get(a, b).total);
  const rows = (sql) => db.prepare(sql).all(from, to).map((r) => ({ ...r }));
  const counts = new Map(rows('SELECT day, SUM(count) AS count FROM visits WHERE day BETWEEN ? AND ? GROUP BY day').map((r) => [r.day, r.count]));
  const days = [];
  for (let i = 7; i >= 1; i--) days.push({ day: day(i), count: counts.get(day(i)) ?? 0 });
  const top = (column) => rows(`SELECT ${column} AS key, SUM(count) AS count FROM details WHERE day BETWEEN ? AND ? GROUP BY ${column} ORDER BY count DESC LIMIT 5`);
  return {
    from, to,
    visits: sum('visits', from, to),
    previous: sum('visits', prevFrom, prevTo),
    downloads: sum('downloads', from, to),
    days,
    pages: rows('SELECT path AS key, SUM(count) AS count FROM visits WHERE day BETWEEN ? AND ? GROUP BY path ORDER BY count DESC'),
    sources: top('source'),
    countries: top('country'),
    devices: top('device'),
  };
}

export function reportEmail(r) {
  const asDate = (d) => new Date(`${d}T12:00:00Z`);
  const period = `del ${fmtLong.format(asDate(r.from))} al ${fmtLong.format(asDate(r.to))}`;
  let change = 'igual que la semana anterior';
  if (r.previous === 0 && r.visits > 0) change = 'la semana anterior no hubo ninguna';
  else if (r.visits !== r.previous) {
    const pct = Math.round(((r.visits - r.previous) / r.previous) * 100);
    change = `${pct > 0 ? '+' : ''}${pct} % respecto a la semana anterior, que tuvo ${r.previous}`;
  }
  const label = {
    pages: (k) => PAGE_NAMES[k] ?? k,
    sources: (k) => k || 'Directo o desconocido',
    countries: (k) => { try { return k ? regionName.of(k) : 'Desconocido'; } catch { return k; } },
    devices: (k) => DEVICE_NAMES[k] ?? k,
  };
  const sections = [
    ['Páginas', 'pages'],
    ['De dónde llegan', 'sources'],
    ['País', 'countries'],
    ['Dispositivo', 'devices'],
  ].filter(([, key]) => r[key].length);
  const max = Math.max(1, ...r.days.map((d) => d.count));

  const subject = `luisse.pro: ${r.visits} ${r.visits === 1 ? 'visita' : 'visitas'} esta semana`;
  const text = [
    `Visitas ${period}: ${r.visits}; ${change}.`,
    `Descargas del CV en PDF: ${r.downloads}.`,
    '',
    ...r.days.map((d) => `${fmtDay.format(asDate(d.day))}: ${d.count}`),
    ...sections.flatMap(([title, key]) => ['', `${title}:`, ...r[key].map((x) => `  ${label[key](x.key)}: ${x.count}`)]),
    '',
    'Panel completo: https://luisse.pro/estadisticas/',
  ].join('\n');

  const td = 'padding:6px 0;border-top:1px solid #e3e8ee;';
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0e1b2e;max-width:560px;margin:0 auto;padding:24px">
<p style="margin:0;color:#4a586c;font-size:14px">luisse.pro, ${escHtml(period)}</p>
<p style="margin:8px 0 0;font-size:44px;font-weight:700;letter-spacing:-1px">${r.visits} ${r.visits === 1 ? 'visita' : 'visitas'}</p>
<p style="margin:4px 0 0;color:#4a586c">${escHtml(change)}. Descargas del CV en PDF: <b style="color:#0e1b2e">${r.downloads}</b>.</p>
<table role="presentation" style="width:100%;border-collapse:collapse;margin-top:24px;font-size:14px">
${r.days.map((d) => `<tr><td style="${td}width:110px;color:#4a586c">${escHtml(fmtDay.format(asDate(d.day)))}</td><td style="${td}"><div style="height:10px;border-radius:3px;background:#1f4fb8;width:${Math.round((d.count / max) * 100)}%;min-width:${d.count ? 4 : 0}px"></div></td><td style="${td}width:40px;text-align:right">${d.count}</td></tr>`).join('')}
</table>
${sections.map(([title, key]) => `<p style="margin:24px 0 4px;font-weight:700">${title}</p><table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">${r[key].map((x) => `<tr><td style="${td}">${escHtml(label[key](x.key))}</td><td style="${td}text-align:right">${x.count}</td></tr>`).join('')}</table>`).join('')}
<p style="margin:28px 0 0"><a href="https://luisse.pro/estadisticas/" style="color:#1f4fb8;font-weight:700">Abrir el panel de estadísticas</a></p>
</div>`;
  return { subject, text, html };
}

async function sendReport(now = new Date()) {
  const { subject, text, html } = reportEmail(weekReport(now));
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: REPORT_FROM, to: [REPORT_TO], subject, text, html }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Resend respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Fecha y hora de Madrid, para saber si ya es lunes a las 9
function madridNow(now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: REPORT_TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { weekday: parts.weekday, hour: Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}` };
}

async function maybeSendReport() {
  if (!RESEND_API_KEY || !REPORT_TO) return;
  const now = new Date();
  const m = madridNow(now);
  if (m.weekday !== 'Mon' || m.hour < 9) return;
  if (getMeta.get('last_report')?.value === m.date) return;
  try {
    await sendReport(now);
    setMeta.run('last_report', m.date);
    console.log(`Resumen semanal enviado a ${REPORT_TO}`);
  } catch (error) {
    // Se reintentará en la siguiente comprobación
    console.error('No se ha podido enviar el resumen semanal:', error.message);
  }
}

setInterval(maybeSendReport, 10 * 60_000).unref();
setTimeout(maybeSendReport, 30_000).unref();

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

let windowStart = Date.now();
let hitsInWindow = 0;

function underLimit() {
  if (Date.now() - windowStart >= 60_000) {
    windowStart = Date.now();
    hitsInWindow = 0;
  }
  hitsInWindow += 1;
  return hitsInWindow <= MAX_HITS_PER_MINUTE;
}

function readBody(req, limit = 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        reject(Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 }));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, code, body = '', type = 'application/json') {
  res.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/status' && req.method === 'GET') {
      return send(res, 200, await status());
    }

    if (pathname === '/api/homelab' && req.method === 'GET') {
      return send(res, 200, await homelab());
    }

    if (pathname === '/api/hit' && req.method === 'POST') {
      let data;
      try {
        data = JSON.parse(await readBody(req));
      } catch (error) {
        if (error.status === 413) {
          res.on('finish', () => req.destroy());
          return send(res, 413);
        }
        return send(res, 400);
      }
      if (!PAGES.has(data?.path) || !LANGS.has(data?.lang)) return send(res, 400);
      if (looksHuman(req) && underLimit()) {
        const day = isoDay(new Date());
        addVisit.run(day, data.path, data.lang);
        const device = DEVICES.has(data.device) ? data.device : '';
        addDetail.run(day, data.path, countryOf(req), sourceOf(data.ref), device);
      }
      // Se responde igual aunque se haya alcanzado el tope, para no dar pistas
      return send(res, 204);
    }

    if (pathname === '/api/download' && req.method === 'POST') {
      let data;
      try {
        data = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400);
      }
      if (!LANGS.has(data?.lang)) return send(res, 400);
      if (looksHuman(req) && underLimit()) addDownload.run(isoDay(new Date()), data.lang);
      return send(res, 204);
    }

    if (pathname === '/api/estadisticas' && req.method === 'GET') {
      if (!(await accessAllowed(req))) return send(res, 403, JSON.stringify({ error: 'Necesitas entrar con Cloudflare Access.' }));
      const days = Number(new URL(req.url, 'http://localhost').searchParams.get('dias') ?? 30);
      return send(res, 200, JSON.stringify(stats(PERIODS.has(days) ? days : 30)));
    }

    // Envía el resumen ahora, para probarlo. Solo desde dentro del contenedor.
    if (pathname === '/api/resumen/prueba' && req.method === 'POST') {
      if (!isLoopback(req)) return send(res, 404);
      if (!RESEND_API_KEY || !REPORT_TO) return send(res, 400, 'Faltan RESEND_API_KEY o REPORT_TO\n', 'text/plain');
      try {
        await sendReport();
        return send(res, 200, `Resumen enviado a ${REPORT_TO}\n`, 'text/plain');
      } catch (error) {
        return send(res, 502, `${error.message}\n`, 'text/plain');
      }
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      return send(res, 200, 'ok', 'text/plain');
    }

    return send(res, 404);
  } catch (error) {
    console.error(error);
    return send(res, 500);
  }
});

server.listen(PORT, () => console.log(`Estadísticas escuchando en el puerto ${PORT}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
