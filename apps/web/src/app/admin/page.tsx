import { redirect } from 'next/navigation';
import { destinoInicialDoPainel, painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';

/**
 * Porta do painel.
 *
 * Quem não entrou vai ao login. Quem entrou vai para a porta do próprio papel:
 * barbeiro em Meu dia, recepção e gerência em Hoje, dono no Painel. Cadastro
 * ainda não publicado continua no onboarding, porque setup incompleto vem antes
 * da rotina diária. A decisão mora em `destinoInicialDoPainel`, não nesta rota.
 */
export default async function AdminPage() {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  redirect(destinoInicialDoPainel(estado));
}
