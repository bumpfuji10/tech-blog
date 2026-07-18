// @ts-check

import mdx from '@astrojs/mdx';
import { unified } from '@astrojs/markdown-remark';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';
import remarkLinkCards from './src/utils/remarkLinkCards.mjs';

// https://astro.build/config
export default defineConfig({
	site: 'https://kyam.net',
	integrations: [mdx(), sitemap()],
	markdown: {
		processor: unified({
			remarkPlugins: [remarkLinkCards],
		}),
	},
});
