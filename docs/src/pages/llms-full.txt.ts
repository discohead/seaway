/** `/llms-full.txt`: every page as one Markdown document. See `src/lib/llms.ts`. */
import type { APIRoute } from 'astro';

import { llmsFullTxt } from '../lib/llms';

export const GET: APIRoute = async () =>
	new Response(await llmsFullTxt(), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
