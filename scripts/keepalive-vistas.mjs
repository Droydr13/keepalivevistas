import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { recolectarEmbeds } from './fuentes.mjs';

const SEGUNDOS_REPRODUCCION = parseInt(process.env.SEGUNDOS_REPRODUCCION || '180', 10);
const SEGUNDOS_REPRODUCCION_VIDSST = parseInt(process.env.SEGUNDOS_REPRODUCCION_VIDSST || '240', 10);
const CONCURRENCIA = parseInt(process.env.CONCURRENCIA || '2', 10);
const SEGUNDOS_MAXIMOS_BUSQUEDA_VIDEO = parseInt(process.env.SEGUNDOS_MAXIMOS_BUSQUEDA_VIDEO || '30', 10);
const SEGUNDOS_MAXIMOS_BUSQUEDA_FIRESTREAM = parseInt(process.env.SEGUNDOS_MAXIMOS_BUSQUEDA_FIRESTREAM || '150', 10);
const DIAGNOSTICO = process.env.DIAGNOSTICO === '1';
const NAVEGADOR = process.env.NAVEGADOR || 'chromium';
const VISIBLE = process.env.VISIBLE === '1';
const FORMA_VIDSST = process.env.FORMA_VIDSST || 'v';

function esFirestream(url) {
  return /firestream\./i.test(url);
}

function segundosBusqueda(url) {
  return esFirestream(url) ? SEGUNDOS_MAXIMOS_BUSQUEDA_FIRESTREAM : SEGUNDOS_MAXIMOS_BUSQUEDA_VIDEO;
}

function topePorLinkMs(url) {
  const segundos = esVidsSt(url) ? SEGUNDOS_REPRODUCCION_VIDSST : SEGUNDOS_REPRODUCCION;
  return (segundos + segundosBusqueda(url) + 60) * 1000;
}

const ARCHIVO_URLS_A_PROCESAR = process.env.ARCHIVO_URLS_A_PROCESAR || null;
const ARCHIVO_RESULTADOS = process.env.ARCHIVO_RESULTADOS || null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

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
  if (clickearCuerpo) {
    for (const frame of frames) {
      try {
        await frame.locator('body').click({ timeout: 1500 });
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

function urlParaReproducir(embedUrl) {
  if (FORMA_VIDSST !== 'v') return embedUrl;
  const m = embedUrl.match(/^https:\/\/vids\.st\/e\/(\d+)\/?$/);
  return m ? `https://vids.st/v/${m[1]}` : embedUrl;
}

function esVidsSt(embedUrl) {
  return /^https:\/\/vids\.st\//i.test(embedUrl);
}

const TIPOS_RED_DIAGNOSTICO = new Set(['xhr', 'fetch', 'beacon', 'ping', 'eventsource', 'websocket']);
const EXTENSIONES_MEDIA = /\.(ts|m4s|mp4|m3u8|aac|vtt|jpg|jpeg|png|gif|webp|svg|woff2?|css)(\?|$)/i;

function registrarRedDiagnostico(pagina, etiqueta) {
  pagina.on('response', async (resp) => {
    try {
      const req = resp.request();
      const tipo = req.resourceType();
      const url = req.url();
      if (EXTENSIONES_MEDIA.test(url)) return;
      if (!TIPOS_RED_DIAGNOSTICO.has(tipo) && req.method() !== 'POST') return;
      let cuerpo = '';
      const tipoContenido = resp.headers()['content-type'] || '';
      if (/json|text|javascript/i.test(tipoContenido)) {
        cuerpo = (await resp.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      }
      const enviado = req.postData() ? ` datos=${req.postData().replace(/\s+/g, ' ').slice(0, 200)}` : '';
      console.log(`[red] ${etiqueta} ${req.method()} ${resp.status()} (${tipo}) ${url.slice(0, 200)}${enviado}${cuerpo ? ` -> ${cuerpo}` : ''}`);
    } catch {}
  });
}

async function capturar(paginas, embedUrl, momento) {
  try {
    await mkdir('screenshots', { recursive: true });
    for (const [idx, p] of paginas.entries()) {
      const sufijo = idx === 0 ? '' : `_popup${idx}`;
      await p.screenshot({ path: `screenshots/${nombreSeguro(embedUrl)}_${momento}${sufijo}.png` }).catch(() => {});
    }
  } catch {}
}

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
    extraHTTPHeaders: {
      'sec-ch-ua': '"Chromium";v="125", "Not.A/Brand";v="24", "Google Chrome";v="125"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });
  await ocultarMarcasDeAutomatizacion(contexto);
  const pagina = await contexto.newPage();

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
  const respuestasConError = [];
  pagina.on('response', (resp) => {
    if (resp.status() >= 400) respuestasConError.push(`${resp.status()} ${resp.url()}`);
  });

  try {
    const urlNavegacion = urlParaReproducir(embedUrl);
    const etiqueta = urlNavegacion !== embedUrl ? `${embedUrl} (reproducido en ${urlNavegacion})` : embedUrl;
    if (DIAGNOSTICO) registrarRedDiagnostico(pagina, etiqueta);
    const respuesta = await pagina.goto(urlNavegacion, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pagina.waitForTimeout(2000);

    console.log(
      `[nav] ${etiqueta} -> status ${respuesta ? respuesta.status() : 'sin respuesta'}` +
      `, url final: ${respuesta ? respuesta.url() : pagina.url()}`
    );
    if (pedidosFallidos.length) {
      console.log(`[requestfailed] ${etiqueta} -> ${pedidosFallidos.join(' ; ')}`);
    }
    if (erroresConsola.length) {
      console.log(`[console-error] ${etiqueta} -> ${erroresConsola.slice(0, 5).join(' ; ')}`);
    }
    if (respuestasConError.length) {
      console.log(`[respuestas-error] ${etiqueta} -> ${respuestasConError.slice(0, 8).join(' ; ')}`);
    }
    console.log(`[frames] ${etiqueta} -> ${recolectarFrames(paginasVistas).map((f) => f.url()).join(' | ')}`);

    const inicioBusqueda = Date.now();
    let arranco = false;
    let intentos = 0;
    while (!arranco && Date.now() - inicioBusqueda < segundosBusqueda(embedUrl) * 1000) {
      intentos++;
      arranco = await intentarReproducir(recolectarFrames(paginasVistas), true);
      if (!arranco) await pagina.waitForTimeout(3000);
    }
    console.log(
      `[busqueda-video] ${etiqueta} -> ${intentos} intento(s) en ~${Math.round((Date.now() - inicioBusqueda) / 1000)}s` +
      ` (${arranco ? 'encontrado' : 'no encontrado'})`
    );
    if (!arranco) {
      console.log(`SIN-VIDEO [${etiqueta}] no se encontro un <video> para reproducir`);
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

    if (DIAGNOSTICO) await capturar(paginasVistas, embedUrl, 'inicio');
    const segundosReproduccion = esVidsSt(embedUrl) ? SEGUNDOS_REPRODUCCION_VIDSST : SEGUNDOS_REPRODUCCION;
    const inicio = Date.now();
    let maxTiempo = 0;
    while (Date.now() - inicio < segundosReproduccion * 1000) {
      await pagina.waitForTimeout(15000);
      const t = await obtenerTiempoActual(recolectarFrames(paginasVistas));
      if (typeof t === 'number') {
        if (t > maxTiempo) maxTiempo = t;
        else await intentarReproducir(recolectarFrames(paginasVistas));
      }
    }

    if (DIAGNOSTICO) await capturar(paginasVistas, embedUrl, 'final');
    const avanzo = maxTiempo > 2;
    console.log(
      `${avanzo ? 'OK' : 'ESTANCADO'} [${etiqueta}] reproducido ~${Math.round((Date.now() - inicio) / 1000)}s` +
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
  const embeds = ARCHIVO_URLS_A_PROCESAR
    ? JSON.parse(await readFile(ARCHIVO_URLS_A_PROCESAR, 'utf8'))
    : await recolectarEmbeds();
  console.log(
    `Encontrados ${embeds.length} embed(s) para darles vista ` +
    `(${SEGUNDOS_REPRODUCCION}s de reproduccion c/u, ${SEGUNDOS_REPRODUCCION_VIDSST}s para vids.st, ${CONCURRENCIA} en paralelo, busqueda del video hasta ${SEGUNDOS_MAXIMOS_BUSQUEDA_VIDEO}s y ${SEGUNDOS_MAXIMOS_BUSQUEDA_FIRESTREAM}s para firestream).`
  );
  if (!embeds.length) {
    if (ARCHIVO_RESULTADOS) await writeFile(ARCHIVO_RESULTADOS, '[]');
    return;
  }

  const navegador = await chromium.launch({
    headless: !VISIBLE,
    ...(NAVEGADOR === 'chrome' ? { channel: 'chrome' } : {}),
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(VISIBLE || NAVEGADOR === 'chrome' ? ['--autoplay-policy=no-user-gesture-required'] : []),
      ...(VISIBLE ? [] : ['--headless=new']),
    ],
  });
  console.log(`Navegador: ${NAVEGADOR}${VISIBLE ? ' con ventana (pantalla virtual)' : ' sin ventana'}${DIAGNOSTICO ? ', modo diagnostico' : ''}, vids.st en forma /${FORMA_VIDSST}/`);
  const resultados = [];
  try {
    for (let i = 0; i < embeds.length; i += CONCURRENCIA) {
      const lote = embeds.slice(i, i + CONCURRENCIA);
      const lote_resultados = await Promise.all(
        lote.map((url) => conTope(darVistaConNavegador(navegador, url), topePorLinkMs(url), url))
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

  if (ARCHIVO_RESULTADOS) {
    const vistoEn = new Date().toISOString();
    await writeFile(
      ARCHIVO_RESULTADOS,
      JSON.stringify(resultados.map((r) => ({ url: r.url, ok: r.ok, vistoEn })), null, 2)
    );
  }
}

main();
