# Panel privado de estadísticas

https://luisse.pro/estadisticas/ enseña las visitas por día, por página e idioma, de qué país
y desde qué web llegan, si es móvil u ordenador y cuántas veces se descarga el CV en PDF.

Sigue sin haber cookies ni IPs: el servicio `stats` solo guarda contadores por día. El país lo
pone Cloudflare (cabecera `CF-IPCountry`) y del origen solo se guarda el dominio
(`linkedin.com`), nunca la dirección completa.

El país, el origen y el dispositivo empezaron a guardarse al añadir el panel; las visitas de
antes solo tienen página e idioma, y el panel lo indica.

## Qué cuenta como visita

Para que las cifras se parezcan lo más posible a personas reales, se filtra en dos sitios:

- **En la web** (`src/scripts/visitas.ts`): no cuentan los navegadores automáticos
  (`navigator.webdriver`) ni los que se identifican como bots, y la visita solo se envía cuando
  hay señales de una persona: scroll, toque o tecla, o la página visible al menos 4 segundos.
  Una visita por página y pestaña.
- **En la Pi** (`stats/server.mjs`): se descartan las peticiones de bots conocidos, las que no
  indican el idioma del navegador y las que no vienen de la propia web.

### No contar mis visitas

Entra una vez en https://luisse.pro/?no-contar desde cada navegador y dispositivo que uses.
Saldrá un aviso y ese navegador dejará de sumar visitas y descargas. Para deshacerlo:
https://luisse.pro/?contar. (Se guarda en el navegador: si borras sus datos, hay que repetirlo.)

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

## Resumen semanal por correo

Cada lunes a las 9:00 (hora de Madrid), el servicio `stats` manda un correo con las visitas de
la semana anterior (de lunes a domingo), comparadas con la semana de antes, las descargas del
PDF y de dónde han llegado. Sale de `estadisticas@envio.luisse.pro`, el subdominio de envío que
ya está verificado en Resend.

1. En Resend, crea una API key con permiso *Sending access* solo para `envio.luisse.pro`
   (por ejemplo, llamada `luisse-estadisticas`).
2. En la Pi, añade a `~/web/.env`:

   ```sh
   RESEND_API_KEY=re_...
   REPORT_TO=luis@luisse.pro
   ```

3. En `~/web/docker-compose.yml`, en `environment` del servicio `stats`, las dos líneas
   `RESEND_API_KEY` y `REPORT_TO` (como en `deploy/docker-compose.yml`), y reinicia:
   `docker compose up -d stats`.
4. Para probarlo sin esperar al lunes:

   ```sh
   docker compose exec stats wget -qO- --post-data= http://127.0.0.1:8080/api/resumen/prueba
   ```

   Esa dirección solo responde desde dentro del contenedor.
