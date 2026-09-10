import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { xmlNfseNaApi } from '@/lib/admin-api';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const token = await lerSessaoGestor();
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  if (!token) return new Response('Sessão necessária.', { status: 401, headers });
  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return new Response('Nota inválida.', { status: 400, headers });
  const r = await xmlNfseNaApi(token, id);
  if (!r.ok) return new Response('Não foi possível baixar o XML desta nota.', { status: 404, headers });
  return new Response(r.dados.xml, { headers: { ...headers, 'Content-Type': 'application/xml; charset=utf-8',
    'Content-Disposition': `attachment; filename="nfse-${id}.xml"` } });
}
