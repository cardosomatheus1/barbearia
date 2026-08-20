import { lerRecusaDaPlataforma } from '@/lib/sessao-plataforma';

/**
 * A recusa de uma ação do Super Admin, com a frase que a API escreveu.
 *
 * Par do `AvisoDeRecusa` do painel da barbearia, e separado dele por uma coisa
 * só: o cookie. Os dois painéis têm caminhos de cookie próprios de propósito —
 * quem administra a plataforma quase sempre tem também uma conta de gestor no
 * mesmo navegador —, e um componente compartilhado teria que escolher qual ler
 * ou receber a leitura por parâmetro, que é o mesmo código com uma indireção a
 * mais.
 *
 * O resto da decisão é a mesma e está escrita lá: a frase do domínio primeiro,
 * o mapa da tela como rede.
 */
export async function AvisoDeRecusa({
  erro,
  mapa,
  className = 'painel__aviso',
  children,
}: {
  readonly erro: string | undefined;
  readonly mapa: Readonly<Record<string, string>>;
  readonly className?: string;
  readonly children?: React.ReactNode;
}) {
  if (!erro) return null;
  const recusa = await lerRecusaDaPlataforma();

  return (
    <div className={`ui-alert ui-alert--danger ${className}`} role="alert">
      {recusa ?? mapa[erro] ?? mapa['request_failed'] ?? 'Não deu para salvar. Tente de novo.'}
      {children}
    </div>
  );
}
