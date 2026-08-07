'use server';

import { redirect } from 'next/navigation';
import { criarAgendamentoNaApi } from '@/lib/api';

/**
 * Confirma o agendamento.
 *
 * Server action: o formulário funciona mesmo sem JavaScript, que é o caso de
 * uma parte real do público em rede móvel instável.
 *
 * O corpo carrega só o que o cliente escolheu. Preço, duração e buffers vêm do
 * catálogo no servidor — aceitar preço vindo do formulário deixaria o cliente
 * decidir quanto paga.
 */
export async function criarAgendamento(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? '');
  const start = String(form.get('start') ?? '');
  const date = String(form.get('date') ?? '');
  const serviceIds = String(form.get('serviceIds') ?? '').split(',').filter(Boolean);
  const professionalId = String(form.get('professionalId') ?? '');

  // Volta para o **passo 4**, com tudo preenchido. Sem o marcador `e` a página
  // recomeça do passo 1 e a mensagem de erro nunca aparece.
  const retorno = new URLSearchParams({
    s: serviceIds.join(','),
    p: professionalId,
    d: date,
    h: start,
    e: 'd',
  });

  const resultado = await criarAgendamentoNaApi(slug, {
    locationId: String(form.get('locationId') ?? ''),
    professionalId,
    serviceIds,
    date,
    start,
    name: String(form.get('name') ?? '').trim(),
    phone: String(form.get('phone') ?? '').trim(),
  });

  if (!resultado.ok) {
    retorno.set('erro', resultado.code);
    redirect(`/${slug}/agendar?${retorno.toString()}`);
  }

  // Só o id: a tela de confirmação lê o agendamento da API. Data e hora na URL
  // seriam uma segunda fonte, e ela mentiria se o horário mudasse.
  redirect(`/${slug}/agendado/${resultado.id}`);
}
