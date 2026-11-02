// The app root shows nothing useful to visitors.
export const prerender = false;
export const GET = () => new Response('Not found', { status: 404, headers: { 'X-Robots-Tag': 'noindex, nofollow' } });
