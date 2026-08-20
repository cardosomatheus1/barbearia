import { lerRecusa } from '@/lib/sessao-gestor';

/**
 * A recusa que voltou de uma ação, com a frase que o domínio escreveu.
 *
 * ## O defeito que ela fecha
 *
 * Cada tela traduzia o código da recusa num `Record<string, string>` escrito à
 * mão, com `?? 'Não deu para salvar. Tente de novo.'` no fim. Medido: os
 * controllers mapeiam 239 códigos e os mapas das telas cobriam 142 — **97
 * recusas** chegavam à barbearia como a frase genérica.
 *
 * O custo é concreto. A recepcionista digita 30% de desconto numa casa com teto
 * de 20%; o domínio devolve *"O desconto máximo desta barbearia é R$ X"*, uma
 * frase escrita com o número dentro porque o comentário da rota diz que
 * *"recusado sem o número manda a recepção adivinhar"*. Ela viajava pela rede
 * inteira e era descartada na última linha, e o que aparecia era "Tente de
 * novo" — sobre um formulário que a pessoa ia preencher igual da segunda vez.
 *
 * ## A ordem, e por que ela é esta
 *
 * A frase do domínio **primeiro**, o mapa da tela como rede. É o único lado que
 * conhece o número, o campo e o limite; e é o único que existe para os 97
 * códigos que nenhuma tela mapeia. O mapa continua valendo para o que não passa
 * por ação — leitura que falhou, `request_failed` da rede — e para o que a tela
 * sabe dizer melhor.
 *
 * O comentário de `automacoes` já dizia *"a frase do domínio primeiro"* desde o
 * bloco 98, com o código fazendo o contrário logo abaixo. Duas telas liam o
 * cookie; as outras quarenta e sete nem sabiam que ele existia.
 *
 * ## Por que é componente, e não três linhas em cada tela
 *
 * Porque as três linhas já estavam copiadas quarenta vezes, com a mesma marcação
 * (`ui-alert ui-alert--danger`, `role="alert"`) reescrita em cada uma. Copiar
 * uma quarta linha para dentro de quarenta cópias é fazer a próxima divergência
 * caber em qualquer uma delas.
 */
export async function AvisoDeRecusa({
  erro,
  mapa,
  className = 'painel__aviso',
  children,
}: {
  /** O código que voltou na URL. Ausente é o caminho normal: não desenha nada. */
  readonly erro: string | undefined;
  /**
   * O mapa da tela, como rede.
   *
   * `Record<string, string>` e não `Record<Uniao, string>` de propósito **aqui**:
   * este componente recebe o mapa de quarenta telas, cada uma com a sua união.
   * Quem tem que ser estreito é o mapa na tela, e é lá que o compilador cobra.
   */
  readonly mapa: Readonly<Record<string, string>>;
  readonly className?: string;
  readonly children?: React.ReactNode;
}) {
  if (!erro) return null;
  const recusa = await lerRecusa();

  return (
    <div className={`ui-alert ui-alert--danger ${className}`} role="alert">
      {recusa ?? mapa[erro] ?? mapa['request_failed'] ?? 'Não deu para salvar. Tente de novo.'}
      {children}
    </div>
  );
}
