import { readFile } from 'node:fs/promises';

export const ARCHIVOS_DIRECTOS = [
  'vids-manual-links.json',
  'vids-direct-contribuciones.json',
];

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

export async function recolectarEmbeds() {
  return [...(await recolectarEmbedsConFecha()).keys()];
}
