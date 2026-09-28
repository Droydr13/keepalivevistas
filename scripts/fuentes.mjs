import { readFile } from 'node:fs/promises';

// vids.st: NO se usa "url" (el archivo ya resuelto) -- se confirmo a mano
// que el archivo directo no cuenta como vista. Se usa "referer" (=
// "embedUrl" en los datos reales, siempre la version /e/, la /v/ no
// cuenta). firestream se saco de este sistema: confirmado (por el usuario,
// probando a mano en su propio navegador) que el sitio es demasiado
// pesado de publicidad/popups como para automatizarlo de forma confiable.
export const ARCHIVOS_DIRECTOS = [
  'vids-manual-links.json',
  'vids-direct-contribuciones.json',
];

// Playmate: el embed original (embedUrl).
export const ARCHIVOS_PLAYMATE = [
  'playmate-manual-links.json',
  'playmate-contribuciones.json',
];

export async function leerJsonSiExiste(ruta) {
  try {
    const texto = await readFile(ruta, 'utf8');
    const datos = JSON.parse(texto);
    return Array.isArray(datos) ? datos : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`No se pudo leer ${ruta}: ${e.message}`);
    return [];
  }
}

// Recorre los 4 archivos espejados de addon-latam-datos y devuelve un Map
// url-de-embed -> fecha "agregado" mas antigua vista para esa url (un
// mismo embed puede aparecer repetido -- ej. un mismo episodio subido dos
// veces -- y en ese caso nos interesa la fecha REAL mas vieja, no la
// ultima). Si algun item no trae "agregado" (no deberia pasar con los
// datos reales, pero por las dudas) se usa null, y quien llame decide que
// hacer con eso.
export async function recolectarEmbedsConFecha() {
  const mapa = new Map();
  const marcar = (url, agregado) => {
    if (!url) return;
    const actual = mapa.get(url);
    if (actual === undefined) {
      mapa.set(url, agregado || null);
    } else if (agregado && (!actual || agregado < actual)) {
      mapa.set(url, agregado);
    }
  };
  for (const archivo of ARCHIVOS_DIRECTOS) {
    for (const item of await leerJsonSiExiste(archivo)) {
      if (item && item.referer) marcar(item.referer, item.agregado);
    }
  }
  for (const archivo of ARCHIVOS_PLAYMATE) {
    for (const item of await leerJsonSiExiste(archivo)) {
      if (item && item.embedUrl) marcar(item.embedUrl, item.agregado);
    }
  }
  return mapa;
}

// Usado por keepalive-vistas.mjs cuando se corre suelto/a mano (sin
// ARCHIVO_URLS_A_PROCESAR) -- simplemente todas las urls, sin fechas.
export async function recolectarEmbeds() {
  return [...(await recolectarEmbedsConFecha()).keys()];
}
