import { conexaoWhatsAppNaApi } from '@/lib/admin-api';
import { lerSessaoGestor } from '@/lib/sessao-gestor';

export async function GET() {
  const token = await lerSessaoGestor();
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (!token) return Response.json({ erro: 'Entre novamente para conferir a conexão.' }, { status: 401, headers });
  const r = await conexaoWhatsAppNaApi(token);
  if (!r.ok) return Response.json({ erro: r.message }, { status: r.code === 'forbidden' ? 403 : 503, headers });
  return Response.json(r.dados, { headers });
}
