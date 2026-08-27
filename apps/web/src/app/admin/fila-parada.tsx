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
export function FilaParada({
  fila,
  fuso,
}: {
  readonly fila: SaudeDaFilaNaTela | null;
  /** O fuso da unidade. Sem ele a hora diverge entre servidor e navegador (bloco 135). */
  readonly fuso: string;
}) {
  /**
   * A ordem das três perguntas, e por que ela não é a de escrita.
   *
   * `parada` primeiro porque é o defeito que engole os outros: com o processo
   * fora do ar, nada mais é notícia. `desistiu` **antes** do silêncio porque
   * silêncio explica tarefa esperando e não explica tarefa que desistiu — e
   * uma falha às 22h continua sendo uma falha às 8h.
   *
   * Escrita na ordem inversa, a tela dizia "é noite na barbearia" sobre um
   * motor que tinha morrido de manhã.
   */
  if (fila?.parada) {
    return (
      <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
        <strong>As mensagens não estão saindo.</strong> Há {fila.atrasadas}{' '}
        {fila.atrasadas === 1 ? 'tarefa parada' : 'tarefas paradas'} na fila
        {fila.ultimaConclusao
          ? ` e nada foi processado desde ${quandoCurto(fuso, fila.ultimaConclusao)}`
          : ' e nada foi processado ainda'}
        . O que você montar aqui fica guardado, mas não chega a ninguém enquanto isso não
        voltar — avise quem cuida do sistema.
      </div>
    );
  }

  /**
   * O worker de pé executando uma tarefa que sempre falha (bloco 102).
   *
   * Texto separado porque a resposta é outra: em `parada` alguém sobe um
   * processo, aqui alguém lê um erro. Uma frase só mandaria a barbearia
   * reiniciar o que está funcionando, e a varredura continuaria morrendo.
   */
  if (fila?.desistiu) {
    return (
      <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
        <strong>Alguma coisa parou de tentar.</strong> {fila.falhadas}{' '}
        {fila.falhadas === 1 ? 'tarefa desistiu' : 'tarefas desistiram'} nas últimas 48
        horas, depois de esgotar as tentativas. A fila continua andando, então as outras
        mensagens saem normalmente — mas o que falhou não vai sozinho para o ar. Avise quem
        cuida do sistema.
      </div>
    );
  }

  /**
   * A janela de silêncio, nomeada (bloco 101).
   *
   * Às 23h26 tudo fica parado de propósito — nada sai entre 21h e 8h —, e a
   * tela mostrava o mesmo zero que mostra quando o processo caiu. Duas razões
   * diferentes para o mesmo número, e nenhuma escrita: quem lê não tem como
   * saber se espera ou se avisa alguém.
   *
   * Quem responde é o domínio, porque o fuso vem da **unidade**, nunca do
   * aparelho de quem abriu a tela.
   */
  if (fila?.emSilencio) {
    return (
      <div className="ui-alert painel__aviso" role="status">
        <strong>É noite na barbearia.</strong> Nada sai entre 21h e 8h — o que estiver na
        fila agora começa a sair às 8h. O que você montar aqui fica guardado até lá.
      </div>
    );
  }
  return null;
}

/** "19/08 às 23:26" — o suficiente para saber se foi hoje. */
/**
 * Fuso da unidade, e não do processo (bloco 135).
 *
 * Sem `timeZone`, `Intl` usa UTC no servidor e o do aparelho no navegador: o
 * React não reidrata a hora e a **página inteira** cai com o erro 418. É o
 * defeito D2 com uma segunda consequência, e foi assim que a ficha do cliente
 * quebrou no percurso da medição do bloco 134.
 */
function quandoCurto(fuso: string, iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: fuso,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
