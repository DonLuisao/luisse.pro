// Control de calidad del panel (Sveltia CMS).
// Comprueba que public/admin/config.yml tiene un campo para cada clave de los JSON
// (src/data/cv.*.json y src/data/homelab.*.json)
// (si faltara, el panel la perdería al guardar) y que todos los campos dicen si se
// traducen (i18n: true) o son iguales en los dos idiomas (i18n: duplicate). Un campo
// sin i18n solo se guardaría en español y desaparecería del JSON en inglés.
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const root = new URL('..', import.meta.url);
const config = parse(await readFile(new URL('public/admin/config.yml', root), 'utf8'));
const errors = [];

// Colección del panel y archivo JSON que edita (cada uno en es y en)
const FILES = [
  { collection: 'cv', data: 'cv' },
  { collection: 'homelab', data: 'homelab' },
];

const I18N_OK = new Set([true, 'duplicate']);

// 1. Todos los campos del panel tienen i18n
function checkI18n(fields, path) {
  for (const f of fields ?? []) {
    const here = path ? `${path}.${f.name}` : f.name;
    if (!I18N_OK.has(f.i18n)) errors.push(`${here}: falta "i18n: true" o "i18n: duplicate"`);
    const inner = f.widget === 'list' ? `${here}[]` : here;
    if (f.fields) checkI18n(f.fields, inner);
    if (f.field) checkI18n([f.field], inner);
  }
}

// 2. Cada clave de los JSON tiene su campo en el panel
const byName = (fields) => new Map((fields ?? []).map((f) => [f.name, f]));

function cover(value, field, path) {
  if (Array.isArray(value)) {
    if (field.widget !== 'list') {
      errors.push(`${path}: es una lista en el JSON pero en el panel es "${field.widget}"`);
      return;
    }
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        if (!field.fields) {
          errors.push(`${path}[]: el JSON tiene objetos pero el panel no define sus campos`);
          return;
        }
        coverObject(item, field.fields, `${path}[]`);
      } else if (field.fields) {
        errors.push(`${path}[]: el JSON tiene valores simples pero el panel espera objetos`);
        return;
      }
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    if (field.widget !== 'object') {
      errors.push(`${path}: es un objeto en el JSON pero en el panel es "${field.widget}"`);
      return;
    }
    coverObject(value, field.fields, path);
  }
}

function coverObject(obj, fields, path) {
  const map = byName(fields);
  for (const [key, value] of Object.entries(obj)) {
    const here = path ? `${path}.${key}` : key;
    const field = map.get(key);
    if (!field) {
      errors.push(`${here}: está en el JSON pero no en el panel, y se perdería al guardar`);
      continue;
    }
    cover(value, field, here);
  }
}

for (const { collection, data } of FILES) {
  const file = config.collections?.find((c) => c.name === collection)?.files?.find((f) => f.name === collection);
  if (!file) {
    errors.push(`config.yml: no se encuentra la colección "${collection}" con el archivo "${collection}"`);
    continue;
  }
  const before = errors.length;
  checkI18n(file.fields, '');
  for (const lang of ['es', 'en']) {
    const json = JSON.parse(await readFile(new URL(`src/data/${data}.${lang}.json`, root), 'utf8'));
    coverObject(json, file.fields, '');
  }
  for (let i = before; i < errors.length; i++) errors[i] = `${collection}: ${errors[i]}`;
}

const unique = [...new Set(errors)];
if (unique.length) {
  console.error(`El panel (public/admin/config.yml) tiene ${unique.length} problema(s):`);
  for (const e of unique) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('El panel cubre todos los campos del CV y del homelab.');
