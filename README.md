# CV de Luis Sánchez Elvira (luisse.pro)

Sitio estático en Astro, en español (`/`) e inglés (`/en/`), con tema claro y oscuro.

## Dónde se edita el contenido

Todo el contenido está en dos archivos, uno por idioma:

- `src/data/cv.es.json`
- `src/data/cv.en.json`

Ahí están los textos del CV y también los rótulos de la interfaz (clave `ui`).
Los campos vacíos (`"period": ""`, `"bullets": []`, `"url": ""`) no se pintan.

Pendiente de rellenar:

- Fechas (`period`) de Minsait, Ibermática, ASLAM New IT y Universidad Francisco de Vitoria.
- Tareas (`bullets`) de NTT DATA y ASLAM New IT.
- Orden cronológico de la experiencia, de más reciente a más antigua.

## Comandos

```bash
npm install       # una sola vez
npm run dev       # servidor local en http://localhost:4321
npm run build     # genera el sitio y los dos PDF en dist/
npm run build:site  # solo el sitio, sin PDF (más rápido)
npm run preview   # sirve dist/ para revisarlo
```

Requiere Node.js 20 o superior. La primera vez, instala también el Chromium que usa
el PDF:

```bash
npx playwright install chromium
```

## PDF

`npm run build` genera `dist/Luis-Sanchez-Elvira-CV-ES.pdf` y `-EN.pdf` imprimiendo
las páginas `/cv/` y `/en/cv/`, que salen de los mismos JSON que la web. El diseño
del PDF está en `src/components/Print.astro` y `src/styles/print.css`.

Para ver la hoja mientras la editas, abre `http://localhost:4321/cv/` con `npm run dev`.

Si un PDF ocupa más de una página, el build falla. Para permitir dos:
`PDF_MAX_PAGES=2 npm run build`.

## Publicar

Cada `git push` a `main` comprueba la web y la publica en la Raspberry Pi con
GitHub Actions. Cómo funciona y cómo se configura: [docs/despliegue.md](docs/despliegue.md).

Publicación manual, por si hiciera falta:

```bash
npm run build
rsync -rltvz --delete -e "ssh -i ~/.ssh/cv-deploy -o IdentitiesOnly=yes -o BatchMode=yes" dist/ USUARIO@IP_TAILSCALE_PI:
```

## Datos en vivo de la Raspberry Pi

El panel de la ruta pide `/api/status` y espera un JSON así:

```json
{ "cpu_temp_c": 41.2, "uptime_s": 1987200, "visits_30d": 128 }
```

Mientras no exista, `liveStats` vale `false` en `src/components/CV.astro`: la página
no lo pide y solo muestra "Último despliegue", que sale de la fecha del build.

## Tipografías

Instrument Sans y Red Hat Mono, con licencia OFL, servidas desde `public/fonts/`.
No se carga nada de terceros.

## Estructura

```
src/
  data/         contenido por idioma
  components/   CV.astro, la página entera
  layouts/      Base.astro, <head> y metadatos
  pages/        index.astro (es) y en/index.astro (en)
  styles/       global.css (web) y print.css (PDF)
scripts/        check-data.mjs (control de los datos) y pdf.mjs (genera los PDF)
deploy/         Caddyfile y docker-compose.yml del servidor en la Pi
docs/           despliegue.md
```
