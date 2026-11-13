// Imprime /cv/ y /en/cv/ a PDF dentro de dist/, con el mismo Chromium que usa Playwright.
// Se ejecuta después de `astro build` (ver "build" en package.json).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Control de calidad: el build falla si un PDF ocupa más páginas de las permitidas
const MAX_PAGES = Number(process.env.PDF_MAX_PAGES ?? 1);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

// Las rutas y los nombres de archivo salen de los datos, no se repiten aquí
const jobs = [];
for (const [lang, route] of [['es', '/cv/'], ['en', '/en/cv/']]) {
  const cv = JSON.parse(await readFile(join(ROOT, 'src', 'data', `cv.${lang}.json`), 'utf8'));
  jobs.push({ route, file: cv.meta.pdf.replace(/^\//, '') });
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

// Servidor estático mínimo sobre dist/, solo para la impresión
const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(DIST, path));
  if (!file.startsWith(DIST + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

try {
  for (const { route, file } of jobs) {
    const page = await browser.newPage();
    const response = await page.goto(base + route, { waitUntil: 'networkidle' });
    if (!response?.ok()) throw new Error(`No se pudo abrir ${route} (${response?.status()})`);
    await page.evaluate(() => document.fonts.ready);
    const out = join(DIST, file);
    const pdf = await page.pdf({ path: out, preferCSSPageSize: true, printBackground: true });
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
    const { size } = await stat(out);
    console.log(`PDF ${file}: ${pages} página(s), ${Math.round(size / 1024)} KB`);
    if (pages > MAX_PAGES) {
      throw new Error(
        `${file} ocupa ${pages} páginas y el máximo es ${MAX_PAGES}. ` +
          'Recorta contenido o sube el límite con PDF_MAX_PAGES.',
      );
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
