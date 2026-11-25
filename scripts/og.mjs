// Imagen de vista previa (Open Graph) para cuando se comparte luisse.pro en LinkedIn, WhatsApp...
// Genera dist/og-es.png y dist/og-en.png (1200 × 630) a partir de los datos del CV, con las
// tipografías y colores de la web. Se ejecuta después de `astro build` (ver "build" en package.json).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const font = async (file) => `data:font/woff;base64,${(await readFile(join(ROOT, 'public', 'fonts', file))).toString('base64')}`;

export async function cardHtml(lang) {
  const cv = JSON.parse(await readFile(join(ROOT, 'src', 'data', `cv.${lang}.json`), 'utf8'));
  const { name, headline, role, location } = cv.basics;
  const [regular, bold, mono] = await Promise.all([font('InstrumentSans-Regular.woff'), font('InstrumentSans-Bold.woff'), font('RedHatMono-Regular.woff')]);
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>
@font-face { font-family: I; src: url(${regular}); font-weight: 400; }
@font-face { font-family: I; src: url(${bold}); font-weight: 700; }
@font-face { font-family: M; src: url(${mono}); }
* { margin: 0; box-sizing: border-box; }
body { width: 1200px; height: 630px; background: #0e1b2e; color: #eef1f4; font-family: I, sans-serif; position: relative; overflow: hidden; }
.wrap { position: absolute; inset: 0; padding: 72px 80px 0; }
.name { font-size: 34px; font-weight: 700; color: #a9b6c8; }
h1 { margin-top: 28px; font-size: 96px; line-height: 0.98; letter-spacing: -0.045em; font-weight: 700; max-width: 980px; }
.role { margin-top: 30px; font-size: 32px; color: #eef1f4; }
.foot { position: absolute; left: 80px; right: 80px; bottom: 58px; display: flex; justify-content: space-between; font-family: M, monospace; font-size: 26px; color: #a9b6c8; }
.foot b { color: #f5b700; font-weight: 400; }
/* El cable amarillo y el túnel azul de la portada */
.cable { position: absolute; left: 0; right: 110px; bottom: 122px; height: 10px; background: #f5b700; }
.tunnel { position: absolute; left: 560px; width: 380px; bottom: 113px; height: 28px; border-radius: 14px; background: #2b62d9; }
.tunnel::after { content: ""; position: absolute; left: 18px; right: 18px; top: 11px; height: 6px; background: repeating-linear-gradient(90deg, #f5b700 0 14px, transparent 14px 26px); }
.pi { position: absolute; right: 80px; bottom: 101px; width: 58px; height: 52px; border-radius: 9px; background: #eef1f4; }
</style></head><body><div class="wrap">
<p class="name">${esc(name)}</p>
<h1>${esc(headline)}</h1>
<p class="role">${esc(role)}</p>
</div>
<div class="cable"></div><div class="tunnel"></div><div class="pi"></div>
<p class="foot"><span><b>luisse.pro</b></span><span>${esc(location)}</span></p>
</body></html>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    for (const lang of ['es', 'en']) {
      await page.setContent(await cardHtml(lang), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(DIST, `og-${lang}.png`) });
      console.log(`Imagen de vista previa: og-${lang}.png`);
    }
  } finally {
    await browser.close();
  }
}
