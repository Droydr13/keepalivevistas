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

// firestream en particular es MUY pesado de anuncios: confirmado a mano
// por el usuario que tuvo que cerrar ~20 ventanas emergentes y anuncios
// encima del video antes de que el reproductor real apareciera. Por eso la
// busqueda inicial del <video> no se rinde rapido -- reintenta clickeando
// de forma agresiva durante bastante tiempo antes de declarar SIN-VIDEO.
const SEGUNDOS_MAXIMOS_BUSQUEDA_VIDEO = parseInt(process.env.SEGUNDOS_MAXIMOS_BUSQUEDA_VIDEO || '150', 10);

// Techo duro por link, por si un sitio deja la pagina colgada del todo (un
// interstitial que nunca resuelve ni con reintentos) -- sin esto, un solo
// link trabado se comeria el resto del tiempo del job entero.
const TOPE_POR_LINK_MS = (SEGUNDOS_REPRODUCCION + SEGUNDOS_MAXIMOS_BUSQUEDA_VIDEO + 60) * 1000;

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

// Junta los frames de TODAS las pestañas que este link tiene abiertas ahora
// mismo (la principal, mas cualquier pestaña nueva que se haya decidido
// conservar -- ver mas abajo por que puede haber mas de una).
function recolectarFrames(paginas) {
  return paginas.flatMap((p) => {
    try {
      return p.frames();
    } catch {
      return [];
    }
  });
}

async function intentarReproducir(frames, clickearCuerpo = false) {
  for (const frame of frames) {
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
  for (const frame of frames) {
    for (const sel of SELECTORES_PLAY) {
      try {
        const el = await frame.$(sel);
        if (el) await el.click({ timeout: 1500 });
      } catch {}
    }
  }
  // Muchos reproductores envueltos en publicidad no usan ningun boton
  // reconocible, sino que TODA el area del video es clickeable (a veces
  // hasta abre un popup de publicidad con el click, que se decide mas
  // abajo si se conserva o se cierra). Confirmado a mano que firestream en
  // particular necesita VARIOS de estos clicks seguidos (cerrando
  // anuncios de por medio) antes de que aparezca el reproductor real --
  // por eso, a diferencia de antes, esto se puede pedir en CADA intento y
  // no solo en el ultimo.
  if (clickearCuerpo) {
    for (const frame of frames) {
      try {
        await frame.locator('body').click({ timeout: 1500 }); // click al centro por defecto
      } catch {}
    }
  }
  return false;
}

async function obtenerTiempoActual(frames) {
  for (const frame of frames) {
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
// la pagina -- los dos son la firma tipica de un sitio que chequea si el
// navegador es automatizado. navigator.webdriver es la marca mas conocida,
// pero el log real de firestream mostro algo mas concreto: uno de sus
// scripts de publicidad arma un pedido con "HeadlessChrome" LITERAL en la
// info del navegador (lo que en Chrome se llama "User-Agent Client
// Hints") y ahi mismo la respuesta vuelve con 403 Forbidden -- es decir,
// se estaba delatando solo aunque el navigator.webdriver ya estuviera
// escondido, porque es una señal totalmente distinta (Client Hints, no
// navigator.webdriver). Esta funcion esconde las dos cosas, y algunas
// señales mas, ANTES de que cargue cualquier script de la pagina.
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
    // navigator.userAgentData.brands es la version accesible por
    // JavaScript de esas mismas Client Hints -- por mas que el header
    // HTTP se pise (ver extraHTTPHeaders al armar el contexto), si un
    // script de la pagina la lee por JS igual puede ver "HeadlessChrome"
    // ahi si no se tapa tambien esto.
    try {
      if (navigator.userAgentData) {
        const proto = Object.getPrototypeOf(navigator.userAgentData);
        const marcasFalsas = [
          { brand: 'Not.A/Brand', version: '24' },
          { brand: 'Chromium', version: '125' },
          { brand: 'Google Chrome', version: '125' },
        ];
        Object.defineProperty(proto, 'brands', { get: () => marcasFalsas });
        Object.defineProperty(proto, 'mobile', { get: () => false });
        Object.defineProperty(proto, 'platform', { get: () => 'Windows' });
        const altaOriginal = proto.getHighEntropyValues;
        proto.getHighEntropyValues = function (hints) {
          return altaOriginal.call(this, hints)
            .then((real) => ({
              ...real,
              brands: marcasFalsas,
              fullVersionList: marcasFalsas.map((m) => ({ ...m, version: `${m.version}.0.0.0` })),
              platform: 'Windows',
              platformVersion: '10.0',
              mobile: false,
            }))
            .catch(() => ({ brands: marcasFalsas, mobile: false, platform: 'Windows' }));
        };
      }
    } catch {}
  });
}

async function darVistaConNavegador(navegador, embedUrl) {
  const contexto = await navegador.newContext({
    userAgent: UA,
    // Chrome manda estos headers de "Client Hints" en CADA pedido aparte
    // del User-Agent normal, y Chromium los arma solo -- pisarlos aca es
    // lo que hace que el header HTTP en si tampoco diga "HeadlessChrome"
    // (la parte JS de esto se tapa en ocultarMarcasDeAutomatizacion).
    extraHTTPHeaders: {
      'sec-ch-ua': '"Chromium";v="125", "Not.A/Brand";v="24", "Google Chrome";v="125"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });
  await ocultarMarcasDeAutomatizacion(contexto);
  const pagina = await contexto.newPage();

  // Algunos sitios (sospecha fuerte con firestream, por el "about:blank"
  // que queda en la pestaña principal) usan el patron de abrir el
  // reproductor real en una pestaña NUEVA mientras la original queda en
  // blanco -- si cerraramos toda pestaña nueva de una (como se hacia
  // antes), estariamos cerrando justo la que tiene el video. Por eso ahora
  // se le da una changa a cada pestaña nueva: si tiene un <video> real
  // adentro, se conserva y se usa; si no (o parece un popup de
  // publicidad comun), se cierra igual que antes.
  const paginasVistas = [pagina];
  contexto.on('page', async (nueva) => {
    if (nueva === pagina) return;
    try {
      await nueva.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      await nueva.waitForTimeout(1500);
      const tieneVideo = await intentarReproducir(recolectarFrames([nueva])).catch(() => false);
      if (tieneVideo) {
        console.log(`[popup-con-video] ${embedUrl} -> pestaña nueva (${nueva.url()}) tenia el video, se conserva en vez de cerrarla`);
        paginasVistas.push(nueva);
      } else {
        await nueva.close().catch(() => {});
      }
    } catch {
      try { await nueva.close(); } catch {}
    }
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
  // A diferencia de [console-error] (que solo dice "hubo un 403" sin decir
  // de que pedido), esto anota la URL exacta de cualquier respuesta 4xx/5xx
  // en CUALQUIER frame de esta pestaña -- necesario para saber si el
  // rechazo es de un script de publicidad (no importa mucho) o del propio
  // pedido que carga el reproductor (ahi si importa).
  const respuestasConError = [];
  pagina.on('response', (resp) => {
    if (resp.status() >= 400) respuestasConError.push(`${resp.status()} ${resp.url()}`);
  });

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
    if (respuestasConError.length) {
      console.log(`[respuestas-error] ${embedUrl} -> ${respuestasConError.slice(0, 8).join(' ; ')}`);
    }
    console.log(`[frames] ${embedUrl} -> ${recolectarFrames(paginasVistas).map((f) => f.url()).join(' | ')}`);

    // Confirmado a mano por el usuario (probando firestream el mismo en su
    // propio navegador): el video real NO aparece rapido -- hay que ir
    // cerrando ventanas emergentes y anuncios sucesivos (el usuario conto
    // que le tomo ~20 veces) antes de que el reproductor real cargue. Por
    // eso esto reintenta clickeando de forma agresiva (no solo buscar el
    // <video>, sino tambien clickear como si se estuviera cerrando
    // anuncios) durante bastante tiempo en vez de rendirse a los pocos
    // segundos.
    const inicioBusqueda = Date.now();
    let arranco = false;
    let intentos = 0;
    while (!arranco && Date.now() - inicioBusqueda < SEGUNDOS_MAXIMOS_BUSQUEDA_VIDEO * 1000) {
      intentos++;
      arranco = await intentarReproducir(recolectarFrames(paginasVistas), true);
      if (!arranco) await pagina.waitForTimeout(3000);
    }
    console.log(
      `[busqueda-video] ${embedUrl} -> ${intentos} intento(s) en ~${Math.round((Date.now() - inicioBusqueda) / 1000)}s` +
      ` (${arranco ? 'encontrado' : 'no encontrado'})`
    );
    if (!arranco) {
      console.log(`SIN-VIDEO [${embedUrl}] no se encontro un <video> para reproducir`);
      try {
        await mkdir('screenshots', { recursive: true });
        for (const [idx, p] of paginasVistas.entries()) {
          const sufijo = idx === 0 ? '' : `_popup${idx}`;
          await p.screenshot({ path: `screenshots/${nombreSeguro(embedUrl)}${sufijo}.png`, fullPage: true }).catch(() => {});
        }
      } catch (e) {
        console.log(`(no se pudo guardar captura: ${e.message})`);
      }
      return false;
    }

    const inicio = Date.now();
    let maxTiempo = 0;
    while (Date.now() - inicio < SEGUNDOS_REPRODUCCION * 1000) {
      await pagina.waitForTimeout(15000);
      const t = await obtenerTiempoActual(recolectarFrames(paginasVistas));
      if (typeof t === 'number') {
        if (t > maxTiempo) maxTiempo = t;
        else await intentarReproducir(recolectarFrames(paginasVistas)); // se estanco (pausa, buffering) -- reintenta
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
  // --headless=new fuerza el modo "headless nuevo" de Chrome, que en
  // general se parece mas a un Chrome de escritorio real que el headless
  // viejo (el que mostraba "HeadlessChrome" en varios lados).
  const navegador = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--headless=new'],
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
