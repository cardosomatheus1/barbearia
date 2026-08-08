import { redirect } from 'next/navigation';
import { casaDoPapel, painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';

/**
 * Porta do painel.
 *
 * Quem não entrou vai ao login. Quem entrou vai para **a casa do papel dele**:
 * o barbeiro para a própria agenda, o resto para o onboarding — que é onde o
 * dono continua o cadastro e de onde ele alcança tudo.
 */
export default async function AdminPage() {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  redirect(estado.staff.role === 'professional' ? casaDoPapel(estado) : '/admin/onboarding');
}
