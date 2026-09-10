import { documentoFiscalPeloLinkNaApi } from '@/lib/admin-api';

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (token.length > 1000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return new Response('Link inválido.', { status: 404, headers });
  const r = await documentoFiscalPeloLinkNaApi(token);
  if (!r.ok) return new Response('Este documento não está disponível ou o link expirou. Solicite uma nova via à barbearia.', { status: 404, headers });
  return new Response(new Uint8Array(Buffer.from(r.dados.arquivo, 'base64')), { headers: { ...headers,
    'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="nota-fiscal.pdf"' } });
}
