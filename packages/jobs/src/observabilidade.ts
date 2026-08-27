/**
 * Envelope observável da execução de uma tarefa.
 *
 * Deliberadamente não inclui `payload` nem mensagem de erro: ambos podem
 * carregar telefone, nome, texto de WhatsApp ou dado financeiro. O id técnico
 * da tarefa é a correlação; tenant/kind/tentativa explicam o contexto.
 */
export type EventoDaTarefa =
  | {
      readonly fase: 'inicio';
      readonly tarefaId: string;
      readonly tenantId: string;
      readonly kind: string;
      readonly tentativa: number;
      readonly maxTentativas: number;
    }
  | {
      readonly fase: 'concluida';
      readonly tarefaId: string;
      readonly tenantId: string;
      readonly kind: string;
      readonly tentativa: number;
      readonly maxTentativas: number;
      readonly duracaoMs: number;
    }
  | {
      /**
       * A tarefa rodou, não fez nada, e **disse por quê** (bloco 134).
       *
       * Seis handlers começavam com `if (!recursoLigado(...)) return;` — um
       * `return` puro, sem notificação, sem log e sem motivo. A tarefa era
       * marcada como concluída, e o efeito para quem opera era o pior possível:
       * o balcão apertava "Chamar", nada chegava ao cliente, e não havia onde
       * olhar. Aconteceu em produção e custou duas horas de investigação.
       *
       * `motivo` é código de conjunto fechado, nunca frase: ele vai para o log
       * e não pode carregar telefone nem nome, como o resto deste envelope.
       */
      readonly fase: 'pulada';
      readonly tarefaId: string;
      readonly tenantId: string;
      readonly kind: string;
      readonly tentativa: number;
      readonly maxTentativas: number;
      readonly duracaoMs: number;
      readonly motivo: string;
    }
  | {
      readonly fase: 'reagendada' | 'falhou';
      readonly tarefaId: string;
      readonly tenantId: string;
      readonly kind: string;
      readonly tentativa: number;
      readonly maxTentativas: number;
      readonly duracaoMs: number;
      readonly erroTipo: string;
      readonly erroCodigo?: string;
    };

const CODIGO_DE_ERRO_SEGURO = /^[A-Za-z0-9_.:-]{1,80}$/;

export function identificarErroDaTarefa(erro: unknown): {
  readonly erroTipo: string;
  readonly erroCodigo?: string;
} {
  if (!(erro instanceof Error)) return { erroTipo: 'erro_desconhecido' };
  const candidato = (erro as Error & { code?: unknown }).code;
  return {
    erroTipo: erro.name || 'Error',
    ...(typeof candidato === 'string' && CODIGO_DE_ERRO_SEGURO.test(candidato)
      ? { erroCodigo: candidato }
      : {}),
  };
}


/**
 * Texto que pode ir para `jobs.last_error` sem carregar mensagem de provedor.
 * A coluna é operacional e global; ela guarda classificação, não conteúdo.
 */
export function resumoPersistivelDoErro(erro: unknown): string {
  const seguro = identificarErroDaTarefa(erro);
  return seguro.erroCodigo ? `${seguro.erroTipo}:${seguro.erroCodigo}` : seguro.erroTipo;
}

/**
 * O que um handler devolve quando decide não fazer nada.
 *
 * Devolver — e não `return` puro — é o que transforma silêncio em rastro: o
 * laço vê o motivo, emite `fase: 'pulada'` e a tarefa continua concluída, que é
 * o desfecho certo (não houve erro, houve decisão).
 */
export interface PuloDaTarefa {
  readonly pulada: string;
}

export function ehPulo(valor: unknown): valor is PuloDaTarefa {
  return typeof (valor as PuloDaTarefa | null)?.pulada === 'string';
}

/** O recurso `avisos` está desligado para esta barbearia. */
export const PULO_POR_RECURSO: PuloDaTarefa = { pulada: 'recurso_desligado' };
