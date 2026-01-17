import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

export default defineConfig({
  site: 'https://sswapnil2.github.io',
  integrations: [mdx()],
  markdown: {
    shikiConfig: {
      theme: 'github-light'
    }
  }
});
