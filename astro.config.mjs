import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://gsmin02.github.io',
  vite: {
    plugins: [tailwindcss()],
  },
});
