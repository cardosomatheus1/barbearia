import { NextResponse } from 'next/server';
import { agendaDoAdmin, buscarClientes, estadoDoPainel } from '@/lib/admin-api';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { normalizarBusca } from '@/lib/busca-global';

/**
 * Dados dinâmicos da busca global do V11.
 *
 * Funções não passam por esta rota: o casco já conhece os destinos visíveis e
 * entrega só os que a sessão pode abrir. Aqui entram pessoas e agenda, sempre
 * pelas APIs que já aplicam tenant, unidade e recorte por profissional.
 */
export async function GET(requisicao: Request): Promise<Response> {
  const token = await lerSessaoGestor();
  if (!token) return new NextResponse('Entre no painel.', { status: 401 });

  const q = new URL(requisicao.url).searchParams.get('q')?.trim() ?? '';
  if (normalizarBusca(q).length < 3) {
    return NextResponse.json({ clientes: [], agendamentos: [] }, { headers: { 'cache-control': 'no-store' } });
  }

  const estado = await estadoDoPainel(token);
  if (!estado.ok) return new NextResponse('Sessão inválida.', { status: 401 });

  const permissoes = new Set(estado.dados.staff.permissions);
  const podeVerClientes = permissoes.has('customers.view');
  const podeVerAgenda = permissoes.has('appointments.view') && podeVerClientes;

  const [clientes, agenda] = await Promise.all([
    podeVerClientes ? buscarClientes(token, q) : Promise.resolve(null),
    podeVerAgenda ? agendaDoAdmin(token) : Promise.resolve(null),
  ]);

  const termo = normalizarBusca(q);
  const nomes = new Map(agenda?.ok ? agenda.dados.professionals.map((p) => [p.id, p.name] as const) : []);
  const agendamentos = agenda?.ok
    ? agenda.dados.days
        .flatMap((dia) => dia.entries.map((entrada) => ({ dia, entrada })))
        .filter(({ entrada }) => {
          const profissional = nomes.get(entrada.professionalId) ?? '';
          return normalizarBusca(`${entrada.customerName ?? ''} ${entrada.services.join(' ')} ${profissional}`).includes(termo);
        })
        .slice(0, 6)
        .map(({ dia, entrada }) => ({
          id: entrada.id,
          date: dia.date,
          start: entrada.start,
          customerName: entrada.customerName ?? 'Cliente',
          professionalName: nomes.get(entrada.professionalId) ?? 'Profissional',
          services: entrada.services,
          href: `/admin/dia?d=${encodeURIComponent(dia.date)}#atendimento-${encodeURIComponent(entrada.id)}`,
        }))
    : [];

  return NextResponse.json(
    {
      clientes: clientes?.ok ? clientes.dados.customers.slice(0, 6) : [],
      agendamentos,
    },
    { headers: { 'cache-control': 'no-store, private' } },
  );
}
