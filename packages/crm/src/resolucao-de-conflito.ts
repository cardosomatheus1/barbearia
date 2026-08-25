import type { LinhaAnalisada } from '@barbearia/core';

export interface LinhaGravavelDaImportacao {
  readonly nome: string;
  readonly telefone: string;
  readonly nascimento: string | null;
  readonly observacao: string | null;
  readonly novo: boolean;
}

export interface GuardadoDaImportacao {
  readonly linhas: readonly LinhaGravavelDaImportacao[];
  readonly problemas: readonly LinhaAnalisada[];
}

export type EscolhaDoConflito = 'anterior' | 'linha';

export class ConflitoDoPreviewNaoEncontrado extends Error {
  constructor() {
    super('conflito_nao_encontrado');
    this.name = 'ConflitoDoPreviewNaoEncontrado';
  }
}

/**
 * Parte pura da decisão do R5. Ela não sabe de banco nem de sessão: recebe o
 * snapshot guardado e devolve o próximo snapshot. Assim a escolha usada pela
 * API é testável sem Postgres, e o lock transacional fica só no chamador.
 */
export function resolverConflitoGuardado(
  guardado: Partial<GuardadoDaImportacao>,
  linhaAlvo: number,
  escolha: EscolhaDoConflito,
): GuardadoDaImportacao {
  const linhas = [...(guardado.linhas ?? [])];
  const problemas = [...(guardado.problemas ?? [])];
  const indiceDoProblema = problemas.findIndex(
    (problema) => problema.veredito === 'conflito' && problema.linha === linhaAlvo,
  );
  const conflito = problemas[indiceDoProblema];
  if (!conflito || conflito.veredito !== 'conflito') throw new ConflitoDoPreviewNaoEncontrado();

  const indiceDaLinha = linhas.findIndex((linha) => linha.telefone === conflito.telefone);
  const anterior = linhas[indiceDaLinha];
  if (!anterior) throw new ConflitoDoPreviewNaoEncontrado();

  if (escolha === 'linha') {
    linhas[indiceDaLinha] = {
      nome: conflito.nome,
      telefone: conflito.telefone,
      nascimento: conflito.nascimento,
      observacao: conflito.observacao,
      novo: anterior.novo,
    };

    // Se o mesmo telefone aparece três ou mais vezes, o próximo conflito deve
    // comparar contra a escolha que acabou de virar canônica. Sem isto a tela
    // diria "manter José" mesmo depois de João já ter sido escolhido.
    for (let i = 0; i < problemas.length; i += 1) {
      const restante = problemas[i];
      if (restante?.veredito === 'conflito' && restante.telefone === conflito.telefone) {
        problemas[i] = { ...restante, conflitaCom: conflito.nome };
      }
    }
  }

  problemas.splice(indiceDoProblema, 1);
  return { linhas, problemas };
}
