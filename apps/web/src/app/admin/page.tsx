import { redirect } from 'next/navigation';
import { lerSessaoGestor } from '@/lib/sessao-gestor';

/** Porta do painel: quem já entrou vai ao onboarding, quem não, ao login. */
export default async function AdminPage() {
  redirect((await lerSessaoGestor()) ? '/admin/onboarding' : '/admin/entrar');
}
