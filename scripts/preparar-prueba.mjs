import { writeFile } from 'node:fs/promises';

const entrada = process.env.URLS_ENTRADA || '';
const urls = [...new Set(entrada.split(/[\s,]+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)))];

await writeFile('urls-a-procesar.json', JSON.stringify(urls));
console.log(`${urls.length} link(s) para probar:`);
urls.forEach((u) => console.log(` - ${u}`));
if (!urls.length) process.exit(1);
