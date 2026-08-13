import { withTenant } from '@barbearia/db';
import { RETENCAO_DO_TEXTO_DIAS, chaveDaPergunta } from '@barbearia/core';

/**
 * O registro de lacunas da recepção digital (bloco 66, SPEC §4.17).
 *
 * > *"Pergunta sem resposta configurada → encaminha a um humano e **registra a
 * > lacuna**, para o dono preencher. Essa lista de lacunas é, sozinha, um produto
 * > útil."*
 *
 * A última frase é a razão deste arquivo existir separado do agente. O produto
 * óbvio seria só escalar; o que a SPEC pede é **medir o que ninguém consegue
 * responder** — e transformar isso numa lista de trabalho para o dono.
 */

export interface LacunaDaRecepcao {
  readonly id: string;
  /**
   * Nulo quando o prazo do texto venceu.
   *
   * A linha continua — chave e contador são o produto —, e a tela mostra a
   * pergunta reconstruída da chave. Um `string` aqui obrigaria a inventar um
   * texto, e inventar é o que este bloco inteiro existe para não fazer.
   */
  readonly pergunta: string | null;
  /** A chave normalizada, que nunca vence: é o que a tela mostra sem o texto. */
  readonly chave: string;
  readonly vezes: number;
  readonly primeiraVez: string;
  readonly ultimaVez: string;
}

/**
 * Registra que ninguém soube responder — e conta.
 *
 * `ON CONFLICT DO UPDATE` sobre a chave normalizada: uma linha por pergunta, com
 * contador. Guardar cada ocorrência daria uma tabela sem limite e uma tela que
 * precisa agrupar para dizer qualquer coisa.
 *
 * O texto original é **sobrescrito** pelo mais recente de propósito: "vcs abre
 * dmg" diz ao dono mais sobre o público dele que a versão que alguém digitou
 * certo três meses atrás.
 *
 * Ela **não** lança. Uma falha ao registrar a lacuna não pode derrubar a resposta
 * ao cliente — quem está do outro lado perguntou o preço do corte, e o registro é
 * para o dono. É a mesma decisão da recusa de score do bloco 60, gravada fora da
 * transação com a falha engolida.
 */
export async function registrarLacuna(
  tenantId: string,
  pergunta: string,
  agora: Date = new Date(),
): Promise<void> {
  const chave = chaveDaPergunta(pergunta);
  /**
   * Pergunta que vira chave vazia não é registrada.
   *
   * "???" e "oi" normalizam para nada, e uma chave vazia agruparia toda pergunta
   * ininteligível numa linha só — escondendo que são coisas diferentes e enchendo
   * a tela do dono com uma linha que não dá para agir.
   */
  if (chave.length === 0) return;

  try {
    await withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO reception_gaps (tenant_id, pergunta_chave, pergunta_texto,
                                    primeira_vez, ultima_vez)
        VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                ${chave}, ${pergunta.trim().slice(0, 300)}, ${agora}, ${agora})
        ON CONFLICT (tenant_id, pergunta_chave) DO UPDATE
           SET vezes = reception_gaps.vezes + 1,
               ultima_vez = EXCLUDED.ultima_vez,
               pergunta_texto = EXCLUDED.pergunta_texto,
               -- Perguntar de novo **reabre**: o dono marcou como resolvida e
               -- alguém continua sem resposta, então ela volta para a lista. Sem
               -- isto, resolver errado esconde a pergunta para sempre.
               resolvida_em = NULL,
               resolvida_por = NULL
      `;
    });
  } catch {
    /**
     * Engolida de propósito — ver o cabeçalho da função.
     *
     * O cliente perguntou o preço do corte; o registro é para o dono. Deixar a
     * exceção subir trocaria uma lacuna anotada por uma conversa quebrada.
     */
  }
}

/** As lacunas abertas, da mais perguntada para a menos. */
export async function lacunasDaRecepcao(
  tenantId: string,
  limite = 20,
): Promise<readonly LacunaDaRecepcao[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        pergunta_texto: string | null;
        pergunta_chave: string;
        vezes: number;
        primeira_vez: Date;
        ultima_vez: Date;
      }[]
    >`
      SELECT id, pergunta_texto, pergunta_chave, vezes, primeira_vez, ultima_vez
        FROM reception_gaps
       WHERE resolvida_em IS NULL
       ORDER BY vezes DESC, ultima_vez DESC
       LIMIT ${limite}
    `;
    return linhas.map((l) => ({
      id: l.id,
      pergunta: l.pergunta_texto,
      chave: l.pergunta_chave,
      vezes: l.vezes,
      primeiraVez: l.primeira_vez.toISOString(),
      ultimaVez: l.ultima_vez.toISOString(),
    }));
  });
}

/**
 * Apaga o texto cru das perguntas que ninguém repete há um trimestre.
 *
 * A linha fica: chave e contador são o produto, e não identificam ninguém. O que
 * vence é a **redação original**, que é o único lugar desta tabela onde um nome
 * ou um telefone caberia — alguém digita "meu nome é Ana, telefone tal" e esse
 * texto não é alcançável por `anonimizar_cliente`, porque não há `customer_id`
 * para ligá-lo a ninguém.
 *
 * É a regra de `imports.payload`: cópia de dado pessoal fora de `customers` vive
 * com prazo escrito no schema. Perguntar de novo traz o texto de volta — e aí
 * ele é novo, com prazo novo.
 *
 * Devolve quantas linhas perderam o texto, porque uma varredura que não conta
 * não tem como provar que rodou.
 */
export async function expirarTextoDaRecepcao(entrada: {
  readonly tenantId: string;
  readonly agora?: Date;
}): Promise<number> {
  const agora = entrada.agora ?? new Date();
  const corte = new Date(agora.getTime() - RETENCAO_DO_TEXTO_DIAS * 86_400_000);

  return withTenant(entrada.tenantId, async (tx) => {
    return tx.$executeRaw`
      UPDATE reception_gaps
         SET pergunta_texto = NULL
       WHERE pergunta_texto IS NOT NULL
         AND ultima_vez < ${corte}
    `;
  });
}

/**
 * O dono marca a lacuna como resolvida depois de cadastrar o que faltava.
 *
 * Resolver é **estado**, nunca `DELETE` — a tabela não tem o direito, e a
 * pergunta continua contando para a leitura do trimestre. É a mesma decisão do
 * recado do bloco 43.
 */
export async function resolverLacuna(params: {
  readonly tenantId: string;
  readonly lacunaId: string;
  readonly staffUserId: string;
  readonly agora?: Date;
}): Promise<boolean> {
  const agora = params.agora ?? new Date();
  return withTenant(params.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE reception_gaps
         SET resolvida_em = ${agora}, resolvida_por = ${params.staffUserId}::uuid
       WHERE id = ${params.lacunaId}::uuid AND resolvida_em IS NULL
    `;
    return afetadas === 1;
  });
}
