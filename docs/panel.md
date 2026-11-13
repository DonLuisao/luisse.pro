# Panel de edición

El contenido del CV se puede editar con formularios en **https://luisse.pro/admin/**
(Sveltia CMS). Al guardar, el panel hace un commit en `main` y GitHub Actions comprueba
y publica la web y los PDF, igual que con un `git push`.

## Cómo funcionan los idiomas

El panel edita a la vez `src/data/cv.es.json` y `src/data/cv.en.json`.

- Los textos (puestos, tareas, descripciones…) se escriben en cada idioma.
- Lo que no se traduce (empresa, correo, enlaces, casillas) se escribe en español y
  se copia solo al inglés.
- En las listas (experiencia, formación, proyectos…), añadir, borrar o reordenar un
  elemento se hace en los dos idiomas a la vez. Después solo hay que traducir sus textos.

Si al guardar queda algo relleno en un idioma y vacío en el otro, el control de datos
lo detecta en GitHub Actions y **no se publica**: la web sigue con la versión anterior
hasta que lo corrijas desde el panel.

## Entrar desde cualquier dispositivo (token de GitHub)

La primera vez en cada navegador:

1. En GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens
   → Generate new token**.
2. Nombre: `Panel luisse.pro`. Caducidad: la que prefieras (al caducar, se crea otro).
3. **Repository access → Only select repositories →** `DonLuisao/luisse.pro`.
4. **Permissions → Repository permissions → Contents: Read and write.**
   (Metadata: Read-only se añade solo.)
5. Genera el token y cópialo.
6. En https://luisse.pro/admin/, elige **Sign in with Token** y pégalo.

El token queda guardado en ese navegador. Solo sirve para este repositorio, pero con él
se puede escribir en todo el repositorio: no lo uses en ordenadores ajenos y, si lo
pierdes o sospechas de él, revócalo en la misma página de GitHub.

## Editar en local, sin token (Chrome o Edge)

```bash
npm run dev
```

Abre http://localhost:4321/admin/index.html, elige **Work with Local Repository** y
selecciona la carpeta del proyecto. Los cambios se guardan en tus archivos y se ven al
momento en http://localhost:4321. El panel no hace commits en este modo: guárdalos tú
con `git commit` y `git push`.

Safari no tiene la función que necesita este modo; usa el token.

## Después de editar desde la web

El panel hace el commit directamente en GitHub. Antes de cambiar nada en tu Mac:

```bash
git pull
```

## Si añades un campo nuevo al JSON

Añádelo también en `public/admin/config.yml`, con `i18n: true` o `i18n: duplicate`.
Si no, el build falla con un aviso de `scripts/check-cms.mjs`: el panel no conocería
ese campo y lo borraría al guardar.
