// Contador de visitas de luisse.pro: lo más parecido posible a "personas que han mirado la página".
//
// - Una visita por página y pestaña. Sin cookies: sessionStorage se queda en el navegador.
// - Se respeta Global Privacy Control.
// - No cuentan los navegadores automáticos ni los que se identifican como bots.
// - Solo cuenta cuando hay señales de una persona: scroll, toque o tecla, o la página visible
//   al menos 4 segundos. Los rastreadores cargan y se van antes; las pestañas en segundo plano
//   no cuentan hasta que se miran.
// - luisse.pro/?no-contar hace que ese navegador deje de contar (para mis propias visitas);
//   luisse.pro/?contar lo deshace.
//
// El servidor (stats/server.mjs) vuelve a filtrar por su cuenta.

const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|preview|headless|lighthouse|pagespeed|ptst|inspectiontool|facebookexternalhit|whatsapp|telegram|discord|embedly|skype|curl|wget|python|httpclient|phantom|puppeteer|playwright|selenium/i;
const OPT_OUT = 'no-contar';
const VISIBLE_MS = 4000;

function enabled(): boolean {
  if (location.hostname !== 'luisse.pro') return false;
  if ((navigator as any).globalPrivacyControl) return false;
  if ((navigator as any).webdriver || BOT_UA.test(navigator.userAgent)) return false;
  try {
    if (localStorage.getItem(OPT_OUT) === '1') return false;
  } catch (e) {}
  return true;
}

// ?no-contar y ?contar: guarda la preferencia, limpia la dirección y lo confirma en pantalla
function handleOptOut(lang: string) {
  const params = new URLSearchParams(location.search);
  const off = params.has('no-contar');
  const on = params.has('contar');
  if (!off && !on) return;
  try {
    if (off) localStorage.setItem(OPT_OUT, '1');
    else localStorage.removeItem(OPT_OUT);
  } catch (e) {
    return;
  }
  params.delete('no-contar');
  params.delete('contar');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  const es = lang === 'es';
  const text = off
    ? es ? 'Este navegador ya no cuenta en las visitas.' : 'This browser no longer counts as a visit.'
    : es ? 'Este navegador vuelve a contar en las visitas.' : 'This browser counts as a visit again.';
  const note = document.createElement('p');
  note.textContent = text;
  note.setAttribute('role', 'status');
  Object.assign(note.style, {
    position: 'fixed', left: '50%', bottom: '1.5rem', transform: 'translateX(-50%)', zIndex: '50',
    margin: '0', padding: '0.7rem 1.1rem', borderRadius: '0.6rem',
    background: 'var(--ink)', color: 'var(--bg)', font: '700 0.9375rem var(--font)',
  });
  document.body.append(note);
  setTimeout(() => note.remove(), 4000);
}

function source(): string {
  try {
    return document.referrer ? new URL(document.referrer).hostname : '';
  } catch (e) {
    return '';
  }
}

function device(): 'mobile' | 'desktop' {
  const mobile = (navigator as any).userAgentData?.mobile ?? /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  return mobile ? 'mobile' : 'desktop';
}

export function countVisit(lang: string) {
  handleOptOut(lang);
  if (!enabled()) return;
  const key = `visita:${location.pathname}`;
  try {
    if (sessionStorage.getItem(key)) return;
  } catch (e) {
    return;
  }

  const payload = JSON.stringify({ path: location.pathname, lang, ref: source(), device: device() });
  let sent = false;
  let visibleFor = 0;
  let visibleSince = document.visibilityState === 'visible' ? performance.now() : null;
  const events = ['scroll', 'pointerdown', 'keydown', 'touchstart'] as const;

  const send = () => {
    if (sent || !enabled()) return;
    sent = true;
    try {
      sessionStorage.setItem(key, '1');
    } catch (e) {}
    navigator.sendBeacon('/api/hit', payload);
    stop();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') visibleSince = performance.now();
    else if (visibleSince !== null) {
      visibleFor += performance.now() - visibleSince;
      visibleSince = null;
    }
  };
  const timer = setInterval(() => {
    const total = visibleFor + (visibleSince === null ? 0 : performance.now() - visibleSince);
    if (total >= VISIBLE_MS) send();
  }, 500);
  function stop() {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    for (const e of events) window.removeEventListener(e, send);
  }
  document.addEventListener('visibilitychange', onVisibility);
  for (const e of events) window.addEventListener(e, send, { passive: true, once: true });
}

// Descargas del CV en PDF, con los mismos filtros
export function countDownloads(lang: string) {
  document.querySelectorAll<HTMLAnchorElement>('a[download]').forEach((a) =>
    a.addEventListener('click', () => {
      if (enabled()) navigator.sendBeacon('/api/download', JSON.stringify({ lang }));
    }),
  );
}
