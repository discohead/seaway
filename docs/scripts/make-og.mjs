#!/usr/bin/env node
/**
 * Draws the image a link to the docs unfurls with: public/og.png, 1200 by 630.
 *
 *     node scripts/make-og.mjs
 *
 * Run it by hand when the look changes, and commit the result. It is not part of the build: the
 * text is set in whatever sans-serif the machine has, so the build would not be reproducible.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'og.png');

const waves = Array.from({ length: 30 }, (_, row) => {
	const y = 20 + row * 26;
	const segments = Array.from({ length: 10 }, () => 'c22-11 44-11 66 0s44 11 66 0').join('');
	return `<path d="M-60 ${y}${segments}" />`;
}).join('');

const sans = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const mono = "Menlo, 'SF Mono', Consolas, monospace";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="fade" cx="78%" cy="30%" r="70%">
      <stop offset="0" stop-color="#fff" stop-opacity="1" />
      <stop offset="1" stop-color="#fff" stop-opacity="0" />
    </radialGradient>
    <mask id="mask"><rect width="1200" height="630" fill="url(#fade)" /></mask>
  </defs>
  <rect width="1200" height="630" fill="#0a0f12" />
  <g mask="url(#mask)" fill="none" stroke="#2ac4af" stroke-opacity="0.34" stroke-width="1.5">${waves}</g>

  <g transform="translate(80 84)">
    <g fill="none" stroke="#3fd9c4" stroke-width="6.5" stroke-linecap="round">
      <path d="M2 14c8-10 16-10 24 0s16 10 24 0" />
      <path d="M2 32c8-10 16-10 24 0s16 10 24 0" opacity="0.55" />
    </g>
    <text x="70" y="36" font-family="${sans}" font-size="38" font-weight="700" fill="#f4f7f8" letter-spacing="-1">seaway</text>
  </g>

  <text x="80" y="330" font-family="${sans}" font-size="88" font-weight="700" fill="#f4f7f8" letter-spacing="-3.5">The layer in front</text>
  <text x="80" y="432" font-family="${sans}" font-size="88" font-weight="700" fill="#f4f7f8" letter-spacing="-3.5">of <tspan font-family="${mono}" font-size="80" fill="#7ce9da" letter-spacing="-4">exec</tspan></text>

  <text x="80" y="520" font-family="${sans}" font-size="30" fill="#bac6cc">A framework for Archil. Contexts, statements, plans and turns,</text>
  <text x="80" y="562" font-family="${sans}" font-size="30" fill="#bac6cc">in Python and TypeScript.</text>
</svg>`;

await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
console.log(`wrote ${path.relative(process.cwd(), out)}`);
