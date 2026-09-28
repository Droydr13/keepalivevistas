import { readFile, writeFile } from 'node:fs/promises';
import { recolectarEmbedsConFecha } from './fuentes.mjs';

const DIAS_ENTRE_VISTAS = parseInt(process.env.DIAS_ENTRE_VISTAS || '7', 10);
const MAX_JOBS_PARALELOS = parseInt(process.env.MAX_JOBS_PARALELOS || '15', 10);
const MIN_POR_JOB = parseInt(process.env.MIN_POR_JOB || '3', 10);

const ARCHIVO_ESTADO = process.env.ARCHIVO_ESTADO || 'vistas-estado.json';
const ARCHIVO_MATRIX_SALIDA = process.env.ARCHIVO_MATRIX_SALIDA || 'matrix.json';

async function leerEstado() {
  try {
    return JSON.parse(await readFile(ARCHIVO_ESTADO, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return {};
  }
}

function repartirEnChunks(urls, numChunks) {
  const chunks = Array.from({ length: numChunks }, () => []);
  urls.forEach((url, i) => chunks[i % numChunks].push(url));
  return chunks.filter((c) => c.length > 0);
}

async function main() {
  const embedsConFecha = await recolectarEmbedsConFecha();
  const estado = await leerEstado();
  const ahora = Date.now();
  const topeMs = DIAS_ENTRE_VISTAS * 24 * 60 * 60 * 1000;

  let nuevos = 0;
  const debidos = [];

  for (const [url, agregado] of embedsConFecha) {
    if (!estado[url]) {
      estado[url] = { primeraVezVisto: agregado || new Date(ahora).toISOString(), ultimaVista: null };
      nuevos++;
    }
    const e = estado[url];
    if (!e.ultimaVista || ahora - Date.parse(e.ultimaVista) >= topeMs) {
      debidos.push(url);
    }
  }

  await writeFile(ARCHIVO_ESTADO, JSON.stringify(estado, null, 2) + '\n');

  const numChunks = Math.max(1, Math.min(MAX_JOBS_PARALELOS, Math.ceil(debidos.length / MIN_POR_JOB)));
  const chunks = debidos.length ? repartirEnChunks(debidos, numChunks) : [];
  const matrix = chunks.map((urls, indice) => ({ indice, urls }));

  await writeFile(ARCHIVO_MATRIX_SALIDA, JSON.stringify(matrix));

  console.log(`Links conocidos: ${embedsConFecha.size} (${nuevos} nuevo(s) hoy).`);
  console.log(`Debidos hoy (nunca vistos o con ${DIAS_ENTRE_VISTAS}+ dias sin vista): ${debidos.length}.`);
  console.log(`Repartidos en ${matrix.length} job(s) del matrix.`);

  const hayTrabajo = matrix.length > 0;
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(
      process.env.GITHUB_OUTPUT,
      `matrix=${JSON.stringify(matrix)}\nhayTrabajo=${hayTrabajo}\n`,
      { flag: 'a' }
    );
  }
}

main();
