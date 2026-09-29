import { readFile, writeFile } from 'node:fs/promises';

const ARCHIVO_ESTADO = process.env.ARCHIVO_ESTADO || 'vistas-estado.json';
const ARCHIVO_NUEVOS = process.env.ARCHIVO_NUEVOS || 'nuevos-registrados.json';

async function leerJson(ruta, porDefecto) {
  try {
    return JSON.parse(await readFile(ruta, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return porDefecto;
  }
}

async function main() {
  const estado = await leerJson(ARCHIVO_ESTADO, {});
  const nuevos = await leerJson(ARCHIVO_NUEVOS, {});

  let agregados = 0;
  for (const [url, entrada] of Object.entries(nuevos)) {
    if (!estado[url]) {
      estado[url] = entrada;
      agregados++;
    }
  }

  await writeFile(ARCHIVO_ESTADO, JSON.stringify(estado, null, 2) + '\n');
  console.log(`Links nuevos aplicados sobre el estado actual: ${agregados}.`);
}

main();
