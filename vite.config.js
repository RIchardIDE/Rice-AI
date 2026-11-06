import { defineConfig } from 'vite';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const htmlInputs = Object.fromEntries(
    readdirSync(__dirname)
        .filter(fileName => fileName.endsWith('.html'))
        .map(fileName => [fileName.replace(/\.html$/, ''), resolve(__dirname, fileName)])
);

export default defineConfig({
    build: {
        rollupOptions: {
            input: htmlInputs
        }
    }
});
