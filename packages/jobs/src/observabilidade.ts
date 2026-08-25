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
