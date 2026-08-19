import type { SaudeDaFilaNaTela } from '@/lib/admin-api';

/**
 * "As mensagens não estão saindo" — o aviso que faltava (bloco 101).
 *
 * ## O defeito
 *
 * O produto dizia que tinha mandado e não tinha. A campanha ficava em
 * `Enviando · 0 enviados`, a automação prometia *"rodam de hora em hora"*, a
 * tela de WhatsApp mostrava três `FEITO` verdes — e havia trinta e três
 * mensagens paradas na fila com o processo que as manda fora do ar.
 *
 * As quatro telas estavam certas sobre a **intenção** e mudas sobre o **fato**.
 * Nenhuma sabia distinguir "esperando as 8h" de "a máquina parou", e quem opera
 * só descobriria pelo cliente que não voltou.
 *
 * ## Por que num componente só
 *
 * Duas telas mostram o mesmo aviso, e escrever o texto duas vezes é como duas
 * telas passam a dizer coisas diferentes sobre o mesmo fato (§6, pergunta 6).
 *
 * ## Por que ele quase nunca aparece
 *
 * Só com tarefa **vencida** e nada concluído há mais de quinze minutos: a
 * barbearia sem nada a fazer tem a fila vazia e silenciosa, e isso é o certo.
 * Alarme que dispara à toa é alarme que se aprende a ignorar, e um canal
 * ignorado é pior que canal nenhum.
 */
export function FilaParada({ fila }: { readonly fila: SaudeDaFilaNaTela | null }) {
  if (!fila?.parada) return null;
  return (
    <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
      <strong>As mensagens não estão saindo.</strong> Há {fila.atrasadas}{' '}
      {fila.atrasadas === 1 ? 'tarefa parada' : 'tarefas paradas'} na fila
      {fila.ultimaConclusao
        ? ` e nada foi processado desde ${quandoCurto(fila.ultimaConclusao)}`
        : ' e nada foi processado ainda'}
      . O que você montar aqui fica guardado, mas não chega a ninguém enquanto isso não
      voltar — avise quem cuida do sistema.
    </div>
  );
}

/** "19/08 às 23:26" — o suficiente para saber se foi hoje. */
function quandoCurto(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
