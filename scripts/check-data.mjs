// Control de calidad de los datos del CV.
// Comprueba que cv.es.json y cv.en.json tienen la misma estructura, que lo que no
// depende del idioma (enlaces, correo, empresas...) es igual en los dos, y que no
// hay campos rellenos en un idioma y vacíos en el otro.
import { readFile } from 'node:fs/promises';

const load = async (lang) =>
  JSON.parse(await readFile(new URL(`../src/data/cv.${lang}.json`, import.meta.url), 'utf8'));

const es = await load('es');
const en = await load('en');
const loadHomelab = async (lang) =>
  JSON.parse(await readFile(new URL(`../src/data/homelab.${lang}.json`, import.meta.url), 'utf8'));
const labEs = await loadHomelab('es');
const labEn = await loadHomelab('en');
const errors = [];

// Claves cuyo valor tiene que ser idéntico en los dos idiomas
const SAME_IN_BOTH = new Set(['url', 'email', 'phone', 'company', 'id', 'tier', 'monitor', 'from', 'to', 'kind']);

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
compare(labEs, labEn, 'homelab', '');

// Homelab: identificadores únicos, filas y tipos de cable válidos, y cables entre tarjetas que existen
{
  const TIERS = new Set(['internet', 'network', 'devices', 'clients']);
  const KINDS = new Set(['tunnel', 'remote', 'backup', 'sync', 'lan']);
  const ids = new Set();
  for (const [i, n] of (labEs.nodes ?? []).entries()) {
    if (!/^[a-z0-9-]+$/.test(n.id ?? '')) errors.push(`homelab.nodes[${i}].id: "${n.id}" solo puede tener minúsculas, números y guiones`);
    if (ids.has(n.id)) errors.push(`homelab.nodes[${i}].id: "${n.id}" está repetido`);
    ids.add(n.id);
    if (!TIERS.has(n.tier)) errors.push(`homelab.nodes[${i}].tier: "${n.tier}" no es una fila válida`);
  }
  if ((labEs.nodes ?? []).filter((n) => n.tier === 'network').length > 1) {
    errors.push('homelab.nodes: solo puede haber un equipo en la fila "Red"');
  }
  for (const [i, l] of (labEs.links ?? []).entries()) {
    if (!ids.has(l.from)) errors.push(`homelab.links[${i}].from: no hay ningún equipo "${l.from}"`);
    if (!ids.has(l.to)) errors.push(`homelab.links[${i}].to: no hay ningún equipo "${l.to}"`);
    if (!KINDS.has(l.kind)) errors.push(`homelab.links[${i}].kind: "${l.kind}" no es un tipo de cable válido`);
  }
}

// Campos que no pueden faltar
for (const [lang, cv] of [['español', es], ['inglés', en]]) {
  for (const field of ['meta.title', 'meta.description', 'meta.pdf', 'basics.name', 'basics.email']) {
    const value = field.split('.').reduce((o, k) => o?.[k], cv);
    if (typeof value !== 'string' || !value.trim()) errors.push(`${field}: vacío en ${lang}`);
  }
}
if (es.meta?.pdf === en.meta?.pdf) errors.push('meta.pdf: los dos idiomas usan el mismo nombre de archivo');

if (errors.length) {
  console.error(`Los datos del CV y del homelab tienen ${errors.length} problema(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('Datos del CV y del homelab correctos en los dos idiomas.');
