import type { CollectionEntry } from 'astro:content';

type BlogPost = CollectionEntry<'blog'>;

export function sortPostsByPublishedDateDesc(posts: BlogPost[]) {
	return [...posts].sort((a, b) => {
		const dateOrder = b.data.pubDate.valueOf() - a.data.pubDate.valueOf();
		if (dateOrder !== 0) return dateOrder;

		return b.id.localeCompare(a.id);
	});
}
