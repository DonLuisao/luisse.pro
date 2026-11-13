# Despliegue automático en la Raspberry Pi

Cada `git push` a `main` ejecuta `.github/workflows/deploy.yml`:

1. **Build y controles de calidad**, en todos los push y pull requests:
   - los datos en español e inglés coinciden (`scripts/check-data.mjs`);
   - el panel de edición cubre todos los campos de los datos (`scripts/check-cms.mjs`);
   - la web y los dos PDF se generan, y cada PDF cabe en una página;
   - no hay enlaces internos rotos (lychee);
   - Lighthouse: accesibilidad ≥ 95, SEO ≥ 90 y buenas prácticas ≥ 90; rendimiento < 90 solo avisa.
2. **Despliegue**, solo en `main` y si la variable `DEPLOY_ENABLED` vale `true`:
   - el runner entra en la red de Tailscale con una etiqueta `tag:ci`;
   - copia `dist/` a la Pi con `rsync` por SSH;
   - comprueba que `https://luisse.pro` responde.

La clave SSH del despliegue solo puede escribir en `~/web/site` de la Pi (`rrsync`):
no sirve para abrir una sesión ni para leer nada.

## Secrets y variables del repositorio

En GitHub: **Settings → Secrets and variables → Actions**.

| Nombre | Tipo | Valor |
|---|---|---|
| `TS_OAUTH_CLIENT_ID` | secret | ID del cliente OAuth de Tailscale |
| `TS_OAUTH_SECRET` | secret | Secreto del cliente OAuth de Tailscale |
| `DEPLOY_SSH_KEY` | secret | Clave privada `~/.ssh/cv-deploy` (completa) |
| `PI_HOST` | secret | IP de Tailscale de la Pi (`100.x.y.z`) |
| `PI_USER` | secret | Usuario SSH de la Pi |
| `PI_KNOWN_HOSTS` | secret | Salida de `ssh-keyscan -t ed25519 <PI_HOST>` |
| `DEPLOY_ENABLED` | variable | `true` para activar el despliegue |

## Configuración, paso a paso

### 1. Servidor web en la Pi

En la Pi, copia `deploy/Caddyfile` a `~/web/Caddyfile` y actualiza
`~/web/docker-compose.yml` con la línea del Caddyfile que tiene `deploy/docker-compose.yml`.
Después, en `~/web`:

```bash
docker compose up -d
```

El Caddyfile añade cabeceras de caché: HTML y PDF se revalidan siempre, para que
Cloudflare no siga sirviendo una versión antigua después de un despliegue.

### 2. Clave de despliegue

En el Mac:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/cv-deploy -N "" -C "github-deploy-cv"
cat ~/.ssh/cv-deploy.pub
```

En la Pi, comprueba que existe `rrsync` y añade la clave pública a
`~/.ssh/authorized_keys` en una sola línea, con la restricción delante:

```bash
ls /usr/bin/rrsync
echo $HOME
nano ~/.ssh/authorized_keys
```

```
command="/usr/bin/rrsync -wo /home/USUARIO/web/site",restrict ssh-ed25519 AAAA... github-deploy-cv
```

Pruébalo desde el Mac, en este orden. Las opciones `IdentitiesOnly` y `BatchMode`
obligan a usar solo esa clave y nunca piden contraseña, para que la prueba no pueda
entrar con acceso completo por otra vía.

```bash
# 1. Tiene que responder con un error de rrsync, NUNCA con el texto SIN_RESTRICCION
ssh -i ~/.ssh/cv-deploy -o IdentitiesOnly=yes -o BatchMode=yes USUARIO@IP_PI 'echo SIN_RESTRICCION'

# 2. Simulación: muestra qué copiaría, sin tocar nada
rsync -rltvzn --delete -e "ssh -i ~/.ssh/cv-deploy -o IdentitiesOnly=yes -o BatchMode=yes" dist/ USUARIO@IP_PI:

# 3. Copia real
rsync -rltvz --delete -e "ssh -i ~/.ssh/cv-deploy -o IdentitiesOnly=yes -o BatchMode=yes" dist/ USUARIO@IP_PI:
```

Los comandos van escritos enteros a propósito: en zsh, la Terminal por defecto del Mac,
una variable con espacios no se separa en argumentos.

En la prueba 1 importa el texto de la respuesta, no si el comando "falla": `rrsync`
no siempre devuelve un código de error al rechazar una orden. Lo correcto es ver
`rrsync error: SSH_ORIGINAL_COMMAND does not run rsync`. Si ves `SIN_RESTRICCION`,
no sigas. El workflow hace la misma comprobación
antes de cada despliegue y se cancela si la clave no está restringida.

### 3. Tailscale

1. En el panel de Tailscale, **Access controls**, añade la etiqueta al policy file:
   ```json
   "tagOwners": {
     "tag:ci": ["autogroup:admin"]
   },
   ```
   Si tu policy no es la de por defecto (que permite todo), añade también una regla
   que deje a `tag:ci` llegar al puerto 22 de la Pi.
2. En **Settings → OAuth clients** (en paneles recientes, **Trust credentials**),
   crea un cliente con permiso de escritura en **Auth Keys** y la etiqueta `tag:ci`.
3. Guarda el ID y el secreto como `TS_OAUTH_CLIENT_ID` y `TS_OAUTH_SECRET`.

Si la Pi tiene activado Tailscale SSH (`tailscale debug prefs | grep RunSSH`
devuelve `true`), Tailscale intercepta el puerto 22 y la clave de despliegue no se usa.
En ese caso hay que permitir `tag:ci` en la sección `ssh` del policy file, o desactivar
Tailscale SSH en la Pi con `sudo tailscale set --ssh=false`.

### 4. Activar el despliegue

Con los seis secrets creados, crea la variable `DEPLOY_ENABLED` con valor `true` y
lanza el workflow desde **Actions → Comprobar y desplegar → Run workflow**.

## Si algo falla

- **Falla "Comprobar los datos del CV"**: el mensaje dice qué campo no coincide entre idiomas.
- **Falla "Generar la web y los PDF"** con "ocupa 2 páginas": recorta contenido o sube
  `PDF_MAX_PAGES`.
- **Falla Lighthouse**: en el resumen del job hay un enlace al informe completo.
- **Falla "Entrar en la red de Tailscale"** con "requested tags are invalid": la etiqueta
  `tag:ci` no está en `tagOwners` o el cliente OAuth no la tiene asignada.
- **Falla "Copiar la web a la Pi"** con "Host key verification failed": `PI_KNOWN_HOSTS`
  no corresponde a `PI_HOST`.
