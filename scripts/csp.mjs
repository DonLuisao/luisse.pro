// Política de seguridad de contenidos (CSP) para cada página, calculada en el build.
//
// Recorre dist/, calcula el hash de cada <script> y <style> que vaya dentro del HTML y añade
// una etiqueta <meta http-equiv="Content-Security-Policy"> con exactamente esos hashes.
// Así el navegador solo ejecuta el código que hemos publicado: nada inyectado y nada de fuera.
// Se ejecuta después de `astro build` y antes de generar los PDF (ver "build" en package.json).
//
// El panel (/admin/) se queda fuera: carga Sveltia CMS desde unpkg.com y habla con GitHub.
// Las cabeceras que no se pueden poner con <meta> (frame-ancestors, HSTS...) van en deploy/Caddyfile.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const SKIP = ['admin/'];
// Bloques de datos: el navegador no los ejecuta, la CSP no se les aplica
const DATA_TYPES = /^(application\/(ld\+)?json|text\/plain)$/i;

const hash = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name.endsWith('.html')) yield path;
  }
}

export function policyFor(html) {
  const scripts = new Set();
  const styles = new Set();
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    if (type && DATA_TYPES.test(type)) continue;
    scripts.add(hash(body));
  }
  for (const [, body] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) styles.add(hash(body));
  // Los atributos style="..." no se pueden permitir con hashes. Si aparece alguno, esa página
  // permite estilos en línea (los scripts siguen igual de protegidos) y se avisa en el build.
  const styleAttr = /<[a-z][^>]*\sstyle\s*=/i.test(html.replace(/<script\b[\s\S]*?<\/script>/gi, ''));
  return [
    "default-src 'self'",
    `script-src 'self' ${[...scripts].join(' ')}`.trim(),
    styleAttr ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' ${[...styles].join(' ')}`.trim(),
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

export const usesStyleAttributes = (html) => /<[a-z][^>]*\sstyle\s*=/i.test(html.replace(/<script\b[\s\S]*?<\/script>/gi, ''));

export function addPolicy(html) {
  if (/http-equiv=["']Content-Security-Policy/i.test(html)) return html;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policyFor(html)}">`;
  // Justo después de <meta charset>, antes de cualquier script o estilo
  const charset = /<meta\s+charset[^>]*>/i.exec(html);
  if (charset) return html.slice(0, charset.index + charset[0].length) + meta + html.slice(charset.index + charset[0].length);
  return html.replace(/<head[^>]*>/i, (m) => m + meta);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let count = 0;
  for await (const file of htmlFiles(DIST)) {
    const rel = relative(DIST, file).replaceAll('\\', '/');
    if (SKIP.some((s) => rel.startsWith(s))) continue;
    const html = await readFile(file, 'utf8');
    if (usesStyleAttributes(html)) console.warn(`Aviso: ${rel} tiene atributos style="..."; esa página permite estilos en línea.`);
    await writeFile(file, addPolicy(html));
    count++;
  }
  console.log(`CSP añadida a ${count} página(s).`);
}
