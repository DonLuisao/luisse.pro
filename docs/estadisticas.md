# Panel privado de estadísticas

https://luisse.pro/estadisticas/ enseña las visitas por día, por página e idioma, de qué país
y desde qué web llegan, si es móvil u ordenador y cuántas veces se descarga el CV en PDF.

Sigue sin haber cookies ni IPs: el servicio `stats` solo guarda contadores por día. El país lo
pone Cloudflare (cabecera `CF-IPCountry`) y del origen solo se guarda el dominio
(`linkedin.com`), nunca la dirección completa.

El país, el origen y el dispositivo empezaron a guardarse al añadir el panel; las visitas de
antes solo tienen página e idioma, y el panel lo indica.

## Quién puede verlo

La página y los datos los protege Cloudflare Access: antes de llegar a la Pi, Cloudflare pide
entrar con un código que manda a tu correo. Además, el servicio `stats` comprueba la firma del
token que añade Cloudflare, así que aunque alguien se saltara Access no obtendría los datos.

### 1. Crear la aplicación en Cloudflare Zero Trust

1. En *Zero Trust → Access → Applications → Add an application → Self-hosted*.
2. Nombre: `Estadísticas luisse.pro`. Añade dos destinos (*Public hostname*):
   - `luisse.pro`, ruta `estadisticas`
   - `luisse.pro`, ruta `api/estadisticas`
3. Política: *Allow*, regla *Emails* con tu correo. Método de entrada: *One-time PIN*.
4. Guarda. En la ficha de la aplicación, copia el **Application Audience (AUD) Tag**.
5. En *Zero Trust → Settings → Team name and domain* mira tu **team name**
   (lo que va antes de `.cloudflareaccess.com`).

### 2. Configurar la Pi

En `~/web/.env`:

```sh
ACCESS_TEAM=el-team-name
ACCESS_AUD=el-aud-tag
```

En `~/web/docker-compose.yml`, en `environment` del servicio `stats` (como en
`deploy/docker-compose.yml`):

```yaml
      - ACCESS_TEAM=${ACCESS_TEAM:-}
      - ACCESS_AUD=${ACCESS_AUD:-}
```

Copia el servicio nuevo desde el Mac y reinícialo en la Pi:

```sh
scp stats/server.mjs lu1sa0@raspi:web/stats/
```

```sh
cd ~/web && docker compose up -d stats
```

### 3. Comprobarlo

- https://luisse.pro/estadisticas/ en una ventana privada: Cloudflare pide el correo y, tras el
  código, se ve el panel.
- `curl -s https://luisse.pro/api/estadisticas` desde el Mac (sin entrar): Cloudflare tiene que
  bloquearlo, no devolver datos.

Si el panel dice que solo funciona a través de Cloudflare Access estando ya dentro, el `ACCESS_TEAM`
o el `ACCESS_AUD` de la Pi no coinciden con los de la aplicación.
