import { ApiTimeoutError, fetchComTimeout } from '@/lib/fetch-com-timeout';
import { NextResponse } from 'next/server';

const BASE = process.env['API_URL'] ?? 'http://127.0.0.1:3000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARQUIVO = /^[0-9a-f-]{36}\.(?:webp|jpg|png)$/i;

export async function GET(
  _request: Request,
  context: { params: Promise<{ tenantId: string; arquivo: string }> },
) {
  const { tenantId, arquivo } = await context.params;
  if (!UUID.test(tenantId) || !ARQUIVO.test(arquivo)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  let resposta: Response;
  try {
    resposta = await fetchComTimeout(
      `${BASE}/media/${tenantId}/${arquivo}`,
      { cache: 'force-cache' },
      15_000,
    );
  } catch (erro) {
    if (erro instanceof ApiTimeoutError) return new NextResponse(null, { status: 504 });
    return new NextResponse(null, { status: 503 });
  }
  if (!resposta.ok || !resposta.body) return new NextResponse(null, { status: 404 });
  return new NextResponse(resposta.body, {
    status: 200,
    headers: {
      'content-type': resposta.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}
