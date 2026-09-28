import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';

// vids.st/firestream/playmate solo cuentan una "vista" real despues de que
// el video este reproduciendose un rato (2-3 minutos aprox, confirmado a
// mano probando los tres) -- pedirle el archivo directo (con o sin Range)
// no dispara nada de esto, el conteo lo hace el REPRODUCTOR de la pagina
// mientras corre, no el archivo en si. Por eso este script abre cada
// embed con un navegador de verdad (headless) y lo deja "reproduciendo"
// el tiempo que hace falta, en vez de solo pedir bytes.
const SEGUNDOS_REPRODUCCION = parseInt(process.env.SEGUNDOS_REPRODUCCION || '180', 10);

// Cuantos embeds se procesan EN PARALELO -- cada uno abre su propio
// Chromium headless, que consume CPU/RAM real. 2 es conservador para el
// runner estandar de GitHub Actions (2 nucleos); subirlo acelera el total
// pero aumenta el riesgo de que algun sitio note trafico raro viniendo
// todo junto.
const CONCURRENCIA = parseInt(process.env.CONCURRENCIA || '2', 10);

// Techo duro por link, por si un sitio deja la pagina colgada (un
// interstitial de publicidad que nunca resuelve, por ejemplo) -- sin esto,
// un solo link trabado se comeria el resto del tiempo del job entero.
const TOPE_POR_LINK_MS = (SEGUNDOS_REPRODUCCION + 90) * 1000;

// vids.st y firestream: NO se usa "url" (el archivo ya resuelto) -- se
// confirmo a mano que el archivo directo no cuenta como vista para
// ninguno de los dos. Se usa "referer", que ya se guarda desde antes (hoy
// solo se usaba como header al pedir el archivo) y que es el embed
// ORIGINAL que subiste -- para vids.st especificamente, tiene que ser la
// version /e/ (la /v/ tampoco cuenta, confirmado a mano).
const ARCHIVOS_DIRECTOS = [
  'vids-manual-links.json',
  'vids-direct-contribuciones.json',
  'firestream-manual-links.json',
  'firestream-contribuciones.json',
];

// Playmate: el embed original (embedUrl), mismo campo que ya lee el resto
// del sistema.
const ARCHIVOS_PLAYMATE = [
  'playmate-manual-links.json',
  'playmate-contribuciones.json',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

async function leerJsonSiExiste(ruta) {
  try {
    const texto = await readFile(ruta, 'utf8');
    const datos = JSON.parse(texto);
    return Array.isArray(datos) ? datos : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`No se pudo leer ${ruta}: ${e.message}`);
    return [];
  }
}

async function recolectarEmbeds() {
  const embeds = new Set();
  for (const archivo of ARCHIVOS_DIRECTOS) {
    for (const item of await leerJsonSiExiste(archivo)) {
      if (item && item.referer) embeds.add(item.referer);
    }
  }
  for (const archivo of ARCHIVOS_PLAYMATE) {
    for (const item of await leerJsonSiExiste(archivo)) {
      if (item && item.embedUrl) embeds.add(item.embedUrl);
    }
  }
  return [...embeds];
}

// Busca un <video> en la pagina principal o en cualquier iframe (los tres
// sitios meten el reproductor real adentro de un iframe) y le da play. Si
// no arranca solo, prueba clickear los selectores tipicos de un boton de
// play superpuesto (overlay) -- distintos reproductores usan clases
// distintas, asi que se prueban varias.
const SELECTORES_PLAY = [
  '.jw-icon-playback',
  '.vjs-big-play-button',
  '.plyr__control--overlaid',
  '.vjs-poster',
  '[class*="play-button"]',
  '[class*="play_button"]',
  '[class*="playbtn"]',
  '[class*="jw-display-icon-container"]',
];

async function intentarReproducir(pagina, ultimoIntento = false) {
  for (const frame of pagina.frames()) {
    try {
      const arranco = await frame.evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return false;
        v.muted = true;
        v.play().catch(() => {});
        return true;
      });
      if (arranco) return true;
    } catch {}
  }
  for (const frame of pagina.frames()) {
    for (const sel of SELECTORES_PLAY) {
      try {
        const el = await frame.$(sel);
        if (el) await el.click({ timeout: 1500 });
      } catch {}
    }
  }
  // Ultimo recurso: muchos reproductores envueltos en publicidad no usan
  // ningun boton reconocible, sino que TODA el area del video es
  // clickeable (a veces hasta abre un popup de publicidad con el primer
  // click, que ya se cierra solo via el listener de "page" mas abajo) --
  // se prueba solo en el ultimo intento para no gastar clicks de mas.
  if (ultimoIntento) {
    for (const frame of pagina.frames()) {
      try {
        await frame.locator('body').click({ timeout: 1500 }); // click al centro por defecto
      } catch {}
    }
  }
  return false;
}

async function obtenerTiempoActual(pagina) {
  for (const frame of pagina.frames()) {
    try {
      const t = await frame.evaluate(() => {
        const v = document.querySelector('video');
        return v ? v.currentTime : null;
      });
      if (typeof t === 'number') return t;
    } catch {}
  }
  return null;
}

function nombreSeguro(url) {
  return url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 120);
}

// vids.st "reproduce" perfecto (currentTime llega a 180s) pero la vista
// real no sube, y firestream directamente devuelve "about:blank" en vez de
// la pagina -- los dos son la firma tipica de un sitio que chequea con
// JavaScript si el navegador es automatizado (navigator.webdriver = true
// es la marca que deja Playwright/Chromium por defecto) y, si lo detecta,
// bloquea la pagina entera (firestream) o deja que el video se vea pero no
// dispara el aviso de "vista real" que le llega al servidor (vids.st). Este
// script esconde esa marca y algunas otras señales tipicas ANTES de que
// cargue cualquier script de la pagina.
async function ocultarMarcasDeAutomatizacion(contexto) {
  await contexto.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['es-ES', 'es', 'en-US', 'en'] });
    window.chrome = window.chrome || { runtime: {} };
    if (window.navigator.permissions && window.navigator.permissions.query) {
      const consultaOriginal = window.navigator.permissions.query;
      window.navigator.permissions.query = (parametros) =>
        parametros && parametros.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : consultaOriginal(parametros);
    }
  });
}

async function darVistaConNavegador(navegador, embedUrl) {
  const contexto = await navegador.newContext({ userAgent: UA });
  await ocultarMarcasDeAutomatizacion(contexto);
  const pagina = await contexto.newPage();
  // Los popups de publicidad son casi seguros en estos sitios -- se
  // cierran apenas se abren para que no interfieran ni se coman tiempo.
  contexto.on('page', async (nueva) => {
    if (nueva === pagina) return;
    try { await nueva.close(); } catch {}
  });

  // Diagnostico extra para el caso "about:blank" (firestream) -- si la
  // pagina principal termina en blanco no sabemos si fue un redirect, un
  // bloqueo por CSP, un pedido que fallo en la red, o un error de
  // JavaScript de la pagina misma. Esto lo deja registrado sin adivinar.
  const pedidosFallidos = [];
  pagina.on('requestfailed', (req) => {
    if (req.frame() === pagina.mainFrame()) {
      pedidosFallidos.push(`${req.method()} ${req.url()} -> ${req.failure()?.errorText || 'sin detalle'}`);
    }
  });
  const erroresConsola = [];
  pagina.on('console', (msg) => {
    if (msg.type() === 'error') erroresConsola.push(msg.text());
  });
  pagina.on('crash', () => console.log(`[crash] ${embedUrl} la pestana se cayo`));

  try {
    const respuesta = await pagina.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pagina.waitForTimeout(2000);

    // Diagnostico: que respondio el pedido principal (status + URL final
    // despues de redirects, si hubo) y que iframes cargo esta pagina
    // realmente -- ayuda a ver si el reproductor esta en un iframe con otro
    // dominio (a veces uno de publicidad) o si directamente no cargo
    // ningun iframe.
    console.log(
      `[nav] ${embedUrl} -> status ${respuesta ? respuesta.status() : 'sin respuesta'}` +
      `, url final: ${respuesta ? respuesta.url() : pagina.url()}`
    );
    if (pedidosFallidos.length) {
      console.log(`[requestfailed] ${embedUrl} -> ${pedidosFallidos.join(' ; ')}`);
    }
    if (erroresConsola.length) {
      console.log(`[console-error] ${embedUrl} -> ${erroresConsola.slice(0, 5).join(' ; ')}`);
    }
    console.log(`[frames] ${embedUrl} -> ${pagina.frames().map((f) => f.url()).join(' | ')}`);

    // Varios intentos espaciados en vez de dos seguidos -- algunos
    // reproductores tardan bastante en insertar el <video> real (cadenas
    // de redireccion de publicidad antes de mostrar el player).
    let arranco = false;
    for (let intento = 1; intento <= 5 && !arranco; intento++) {
      arranco = await intentarReproducir(pagina, intento === 5);
      if (!arranco) await pagina.waitForTimeout(4000);
    }
    if (!arranco) {
      console.log(`SIN-VIDEO [${embedUrl}] no se encontro un <video> para reproducir`);
      try {
        await mkdir('screenshots', { recursive: true });
        await pagina.screenshot({ path: `screenshots/${nombreSeguro(embedUrl)}.png`, fullPage: true });
      } catch (e) {
        console.log(`(no se pudo guardar captura: ${e.message})`);
      }
      return false;
    }

    const inicio = Date.now();
    let maxTiempo = 0;
    while (Date.now() - inicio < SEGUNDOS_REPRODUCCION * 1000) {
      await pagina.waitForTimeout(15000);
      const t = await obtenerTiempoActual(pagina);
      if (typeof t === 'number') {
        if (t > maxTiempo) maxTiempo = t;
        else await intentarReproducir(pagina); // se estanco (pausa, buffering) -- reintenta
      }
    }

    const avanzo = maxTiempo > 2;
    console.log(
      `${avanzo ? 'OK' : 'ESTANCADO'} [${embedUrl}] reproducido ~${Math.round((Date.now() - inicio) / 1000)}s` +
      ` (currentTime maximo visto: ${maxTiempo.toFixed(1)}s)`
    );
    return avanzo;
  } catch (e) {
    console.log(`FAIL [${embedUrl}] ${e.message}`);
    return false;
  } finally {
    await contexto.close().catch(() => {});
  }
}

async function conTope(promesa, ms, etiqueta) {
  let vencido;
  const timeout = new Promise((resolve) => {
    vencido = setTimeout(() => {
      console.log(`TIMEOUT [${etiqueta}] supero el tope de ${Math.round(ms / 1000)}s, se abandona`);
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([promesa, timeout]);
  } finally {
    clearTimeout(vencido);
  }
}

async function main() {
  const embeds = await recolectarEmbeds();
  console.log(`Encontrados ${embeds.length} embed(s) para darles vista (${SEGUNDOS_REPRODUCCION}s de reproduccion c/u, ${CONCURRENCIA} en paralelo).`);
  if (!embeds.length) return;

  // --disable-blink-features=AutomationControlled apaga (ademas del
  // Object.defineProperty de arriba) otras señales internas de Chromium
  // que delatan que es un navegador manejado por automatizacion.
  const navegador = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const resultados = [];
  try {
    for (let i = 0; i < embeds.length; i += CONCURRENCIA) {
      const lote = embeds.slice(i, i + CONCURRENCIA);
      const lote_resultados = await Promise.all(
        lote.map((url) => conTope(darVistaConNavegador(navegador, url), TOPE_POR_LINK_MS, url))
      );
      lote.forEach((url, idx) => resultados.push({ url, ok: lote_resultados[idx] }));
    }
  } finally {
    await navegador.close();
  }

  const exitosos = resultados.filter((r) => r.ok).length;
  console.log(`\nResumen: ${exitosos}/${resultados.length} embed(s) reprodujeron con exito.`);
  const fallidos = resultados.filter((r) => !r.ok);
  if (fallidos.length) {
    console.log('Fallidos:');
    fallidos.forEach((r) => console.log(` - ${r.url}`));
  }
}

main();
