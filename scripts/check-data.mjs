// Control de calidad de los datos del CV.
// Comprueba que cv.es.json y cv.en.json tienen la misma estructura, que lo que no
// depende del idioma (enlaces, correo, empresas...) es igual en los dos, y que no
// hay campos rellenos en un idioma y vacíos en el otro.
import { readFile } from 'node:fs/promises';

const load = async (lang) =>
  JSON.parse(await readFile(new URL(`../src/data/cv.${lang}.json`, import.meta.url), 'utf8'));

const es = await load('es');
const en = await load('en');
const errors = [];

// Claves cuyo valor tiene que ser idéntico en los dos idiomas
const SAME_IN_BOTH = new Set(['url', 'email', 'phone', 'company']);

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
const join = (path, key) => (path ? `${path}.${key}` : key);

function compare(a, b, path, key) {
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) {
    errors.push(`${path}: tipo distinto (español: ${ta}, inglés: ${tb})`);
    return;
  }

  if (ta === 'array') {
    if (a.length !== b.length) {
      errors.push(`${path}: ${a.length} elementos en español y ${b.length} en inglés`);
    }
    for (let i = 0; i < Math.min(a.length, b.length); i++) compare(a[i], b[i], `${path}[${i}]`, key);
    return;
  }

  if (ta === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) errors.push(`${join(path, k)}: falta en español`);
      else if (!(k in b)) errors.push(`${join(path, k)}: falta en inglés`);
      else compare(a[k], b[k], join(path, k), k);
    }
    return;
  }

  if (ta === 'boolean' || ta === 'number' || SAME_IN_BOTH.has(key)) {
    if (a !== b) errors.push(`${path}: debe ser igual en los dos idiomas ("${a}" / "${b}")`);
    return;
  }

  if (ta === 'string' && (a.trim() === '') !== (b.trim() === '')) {
    const filled = a.trim() ? 'español' : 'inglés';
    const empty = a.trim() ? 'inglés' : 'español';
    errors.push(`${path}: está relleno en ${filled} y vacío en ${empty}`);
  }
}

compare(es, en, '', '');

// Campos que no pueden faltar
for (const [lang, cv] of [['español', es], ['inglés', en]]) {
  for (const field of ['meta.title', 'meta.description', 'meta.pdf', 'basics.name', 'basics.email']) {
    const value = field.split('.').reduce((o, k) => o?.[k], cv);
    if (typeof value !== 'string' || !value.trim()) errors.push(`${field}: vacío en ${lang}`);
  }
}
if (es.meta?.pdf === en.meta?.pdf) errors.push('meta.pdf: los dos idiomas usan el mismo nombre de archivo');

if (errors.length) {
  console.error(`Los datos del CV tienen ${errors.length} problema(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('Datos del CV correctos en los dos idiomas.');
