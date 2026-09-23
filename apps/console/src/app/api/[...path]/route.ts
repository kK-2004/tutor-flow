export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ path: string[] }> };

/** 将浏览器的同源请求转发给内部 API，凭据由 HttpOnly Cookie 自然透传。 */
async function proxy(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const origin = process.env['CONSOLE_API_BASE_URL'] ?? 'http://127.0.0.1:4000';
  const target = new URL(`/api/${path.map(encodeURIComponent).join('/')}`, origin);
  target.search = new URL(request.url).search;

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('content-length');
  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.arrayBuffer();
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body,
    redirect: 'manual',
    cache: 'no-store',
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
