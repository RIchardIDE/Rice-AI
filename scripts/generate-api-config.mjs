import { mkdir, writeFile } from 'node:fs/promises';

const apiUrl = (process.env.VITE_API_URL || '').replace(/\/$/, '');
const config = `window.RICE_API_URL = ${JSON.stringify(apiUrl)};\n`;

await mkdir('public', { recursive: true });
await writeFile('public/api-config.js', config, 'utf8');
