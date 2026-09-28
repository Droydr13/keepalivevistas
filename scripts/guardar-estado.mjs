import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const DIRECTORIO_RESULTADOS = process.env.DIRECTORIO_RESULTADOS || 'resultados-descargados';
const ARCHIVO_ESTADO = process.env.ARCHIVO_ESTADO || 'vistas-estado.json';

async function leerEstado() {
  try {
    return JSON.parse(await readFile(ARCHIVO_ESTADO, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return {};
  }
}

async function juntarResultados() {
  const resultados = [];
  let entradas;
  try {
    entradas = await readdir(DIRECTORIO_RESULTADOS, { recursive: true, withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return resultados;
    throw e;
  }
  for (const entrada of entradas) {
    if (!entrada.isFile() || !entrada.name.endsWith('.json')) continue;
    const ruta = path.join(entrada.parentPath ?? entrada.path, entrada.name);
    try {
      const datos = JSON.parse(await readFile(ruta, 'utf8'));
      if (Array.isArray(datos)) resultados.push(...datos);
    } catch (e) {
      console.warn(`No se pudo leer ${ruta}: ${e.message}`);
    }
  }
  return resultados;
}

async function main() {
  const estado = await leerEstado();
  const resultados = await juntarResultados();

  let actualizados = 0;
  let fallidos = 0;
  let sinEstadoPrevio = 0;

  for (const r of resultados) {
    if (!r || !r.url) continue;
    if (!r.ok) {
      fallidos++;
      continue;
    }
    if (!estado[r.url]) {
      estado[r.url] = { primeraVezVisto: r.vistoEn, ultimaVista: null };
      sinEstadoPrevio++;
    }
    estado[r.url].ultimaVista = r.vistoEn;
    actualizados++;
  }

  await writeFile(ARCHIVO_ESTADO, JSON.stringify(estado, null, 2) + '\n');

  console.log(`Resultados juntados: ${resultados.length}.`);
  console.log(`Actualizados (vista exitosa): ${actualizados}.`);
  console.log(`Fallidos (quedan debidos, se reintentan solos): ${fallidos}.`);
  if (sinEstadoPrevio) console.log(`(${sinEstadoPrevio} no tenian entrada previa en ${ARCHIVO_ESTADO}.)`);
}

main();
