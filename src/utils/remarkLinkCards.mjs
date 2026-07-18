const metadataCache = new Map();

const URL_PATTERN = /^https?:\/\/[^\s<>"']+$/;

function escapeHtml(value = '') {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function stripHtml(value = '') {
	return String(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value = '') {
	return String(value)
		.replaceAll('&amp;', '&')
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&#39;', "'");
}

function getMetaContent(html, key) {
	const patterns = [
		new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'),
		new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${key}["'][^>]*>`, 'i'),
		new RegExp(`<meta[^>]+name=["']${key}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'),
		new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${key}["'][^>]*>`, 'i'),
	];
	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[1]) return decodeEntities(stripHtml(match[1]));
	}
	return '';
}

function getTitle(html) {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match?.[1] ? decodeEntities(stripHtml(match[1])) : '';
}

async function fetchMetadata(url) {
	if (metadataCache.has(url)) return metadataCache.get(url);

	const fallback = {
		title: url,
		description: '',
		image: '',
		host: new URL(url).host,
		url,
	};

	try {
		const response = await fetch(url, {
			headers: {
				'user-agent': 'kyam.net link card fetcher',
				accept: 'text/html,application/xhtml+xml',
			},
			signal: AbortSignal.timeout(5000),
		});
		const html = await response.text();
		const image = getMetaContent(html, 'og:image') || getMetaContent(html, 'twitter:image');
		const metadata = {
			title: getMetaContent(html, 'og:title') || getMetaContent(html, 'twitter:title') || getTitle(html) || url,
			description:
				getMetaContent(html, 'og:description') ||
				getMetaContent(html, 'twitter:description') ||
				getMetaContent(html, 'description'),
			image: image ? new URL(image, url).toString() : '',
			host: new URL(url).host,
			url,
		};
		metadataCache.set(url, metadata);
		return metadata;
	} catch {
		metadataCache.set(url, fallback);
		return fallback;
	}
}

function getStandaloneUrl(node) {
	if (node.type !== 'paragraph' || node.children.length !== 1) return '';

	const child = node.children[0];
	if (child.type === 'text') {
		const value = child.value.trim();
		return URL_PATTERN.test(value) ? value : '';
	}

	if (child.type === 'link' && child.url && child.children.length === 1) {
		const label = child.children[0];
		if (label.type === 'text' && label.value.trim() === child.url && URL_PATTERN.test(child.url)) {
			return child.url;
		}
	}

	return '';
}

async function toLinkCard(url) {
	const metadata = await fetchMetadata(url);
	const image = metadata.image
		? `<span class="link-card-image"><img src="${escapeHtml(metadata.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></span>`
		: '';

	return `<a class="link-card" href="${escapeHtml(metadata.url)}" target="_blank" rel="noopener noreferrer">
	<span class="link-card-body">
		<span class="link-card-title">${escapeHtml(metadata.title)}</span>
		${metadata.description ? `<span class="link-card-description">${escapeHtml(metadata.description)}</span>` : ''}
		<span class="link-card-host">${escapeHtml(metadata.host)}</span>
	</span>
	${image}
</a>`;
}

async function transformNode(node) {
	if (!node.children) return;

	for (let index = 0; index < node.children.length; index += 1) {
		const child = node.children[index];
		const url = getStandaloneUrl(child);
		if (url) {
			node.children[index] = {
				type: 'html',
				value: await toLinkCard(url),
			};
			continue;
		}
		await transformNode(child);
	}
}

export default function remarkLinkCards() {
	return async (tree) => {
		await transformNode(tree);
	};
}
