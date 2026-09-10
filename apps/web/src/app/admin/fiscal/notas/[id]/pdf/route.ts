import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { pdfNfseNaApi } from '@/lib/admin-api';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const token = await lerSessaoGestor();
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  if (!token) return new Response('Sessão necessária.', { status: 401, headers });
  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return new Response('Nota inválida.', { status: 400, headers });
  const r = await pdfNfseNaApi(token, id);
  if (!r.ok) return new Response('O PDF desta nota ainda não está disponível.', { status: 404, headers });
  return new Response(new Uint8Array(Buffer.from(r.dados.arquivo, 'base64')), { headers: { ...headers,
    'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="nfse-${id}.pdf"` } });
}
