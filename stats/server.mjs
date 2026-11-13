// Servicio de estadísticas de luisse.pro. Corre en la Raspberry Pi, detrás de Caddy.
//
//   GET  /api/status  temperatura de la CPU, tiempo encendida y visitas de los últimos 30 días
//   POST /api/hit     suma una visita a una página
//   GET  /api/health  para comprobar que el servicio está vivo
//
// Privacidad: por cada visita solo se guarda el día, la página y el idioma, sumados en un
// contador. No hay cookies, ni IPs, ni nada que permita distinguir a una persona de otra.
//
// Sin dependencias: usa el SQLite que trae Node.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? '/data/stats.db';
const THERMAL_PATH = process.env.THERMAL_PATH ?? '/sys/class/thermal/thermal_zone0/temp';
const UPTIME_PATH = process.env.UPTIME_PATH ?? '/proc/uptime';
// Tope de visitas que se aceptan por minuto entre todos los visitantes, para que nadie
// pueda inflar el contador a base de peticiones.
const MAX_HITS_PER_MINUTE = Number(process.env.MAX_HITS_PER_MINUTE ?? 120);

const PAGES = new Set(['/', '/en/']);
const LANGS = new Set(['es', 'en']);

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
      if (underLimit()) addVisit.run(isoDay(new Date()), data.path, data.lang);
      // Se responde igual aunque se haya alcanzado el tope, para no dar pistas
      return send(res, 204);
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
