'use server';

import { redirect } from 'next/navigation';
import { aceitarConvite } from '@/lib/admin-api';

/**
 * Aceitar o convite de vaga (bloco 39).
 *
 * Não há corpo, e é a regra: serviços, profissional e horário saem da oferta
 * gravada. Se o formulário mandasse qualquer um deles, quem tem o link marcaria
 * outra coisa no horário que conseguiu por prioridade.
 *
 * O token vem do endereço porque ele **é** a credencial desta tela — a mesma
 * decisão do link da fila presencial.
 */
export async function aceitar(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? '');
  const token = String(form.get('token') ?? '');

  const resultado = await aceitarConvite(slug, token);

  redirect(
    resultado.ok
      ? `/${slug}/agendado/${resultado.dados.agendamentoId}`
      : `/${slug}/vaga/${token}?erro=${resultado.code}`,
  );
}
