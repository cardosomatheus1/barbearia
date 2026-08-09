import { withTenant, type TransactionClient } from '@barbearia/db';
import { audit } from '@barbearia/identity';
import {
  decidirRetencao,
  RETENCAO_ANOS,
  type PassoDaRetencao,
} from '@barbearia/core';

/**
 * Anonimização e retenção (bloco 32, SPEC Parte 1 §1.8 regras 3 e 6).
 *
 * ## Anonimizar não é apagar, e a diferença é o ponto do bloco
 *
 * O titular tem direito à exclusão; a barbearia tem obrigação de guardar o
 * registro financeiro. Apagar a linha resolveria o primeiro quebrando o
 * segundo — `orders.customer_id` aponta para ela, e o `ON DELETE CASCADE`
 * levaria a venda junto. O que este módulo faz é remover a **pessoa** de dentro
 * do cadastro e deixar as vendas onde estão, apontando para uma linha que já
 * não identifica ninguém.
 *
 * ## Por que a escrita mora numa função do banco
 *
 * Metade do dado a apagar está em tabela append-only (`customer_consents`,
 * `customer_ledger`), onde `barbearia_app` não tem `UPDATE` — de propósito, e a
 * decisão continua certa. O caminho autorizado é um só, chama-se
 * `anonimizar_cliente` e faz uma coisa. Devolver `UPDATE` à aplicação abriria a
 * reescrita do extrato para qualquer consulta do produto.
 */

export class RetencaoError extends Error {
  constructor(
    readonly code: 'customer_not_found' | 'motivo_obrigatorio',
    message: string,
  ) {
    super(message);
    this.name = 'RetencaoError';
  }
}

export interface ResultadoDaAnonimizacao {
  readonly anonimizado: boolean;
  readonly apelido: string | null;
}

/**
 * Anonimiza um cadastro, com trilha na mesma transação.
 *
 * `tx` opcional para o caso que importa: atender um pedido de exclusão precisa
 * anonimizar **dentro** da transação que encerra o pedido. Um pedido marcado
 * como atendido cuja anonimização falhou depois é pior do que nenhum dos dois —
 * a barbearia acredita ter cumprido a obrigação.
 *
 * A trilha guarda o apelido e **não** o nome que saiu. Registrar "anonimizou
 * Carlos Souza" deixaria o nome na `audit_log`, que é append-only: a
 * anonimização apagaria o dado de um lugar e o gravaria noutro, para sempre.
 */
export async function anonimizarCliente(entrada: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly motivo: string;
  readonly ator: { readonly id: string | null; readonly name: string };
  readonly tx?: TransactionClient;
}): Promise<ResultadoDaAnonimizacao> {
  const motivo = entrada.motivo.trim();
  if (motivo.length < 3) {
    throw new RetencaoError('motivo_obrigatorio', 'Escreva por que este cadastro sai');
  }

  const executar = async (tx: TransactionClient): Promise<ResultadoDaAnonimizacao> => {
    const linhas = await tx.$queryRaw<{ anonimizar_cliente: boolean }[]>`
      SELECT anonimizar_cliente(${entrada.customerId}::uuid, ${motivo})
    `;
    const feito = linhas[0]?.anonimizar_cliente === true;
    if (!feito) return { anonimizado: false, apelido: null };

    const depois = await tx.$queryRaw<{ name: string }[]>`
      SELECT name FROM customers WHERE id = ${entrada.customerId}::uuid
    `;
    const apelido = depois[0]?.name ?? null;

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'customer.anonymized',
      entity: 'customers',
      entityId: entrada.customerId,
      after: { apelido, motivo },
    });

    return { anonimizado: true, apelido };
  };

  return entrada.tx ? executar(entrada.tx) : withTenant(entrada.tenantId, executar);
}

// ---------------------------------------------------------------------------
// Retenção
// ---------------------------------------------------------------------------

export interface CadastroParado {
  readonly customerId: string;
  readonly nome: string;
  readonly ultimaInteracao: Date;
  readonly avisadoEm: Date | null;
}

export interface ResultadoDaVarredura {
  readonly avisados: readonly CadastroParado[];
  readonly anonimizados: number;
}

/**
 * A varredura de retenção de uma barbearia.
 *
 * ## Uma consulta, não uma por cliente
 *
 * "Quando esta pessoa interagiu pela última vez?" é o máximo entre quatro
 * tabelas mais a data do cadastro. Perguntar por cliente seria o N+1 sobre a
 * base inteira, todo dia. A consulta traz só quem já passou do corte — que
 * numa barbearia em operação é um punhado de linhas, não a base.
 *
 * ## `created_at` como piso, `updated_at` **nunca**
 *
 * Interação é atendimento, comanda, lançamento no fiado, entrada na fila. Usar
 * `updated_at` faria a importação de base — que mexe em mil e duzentos
 * cadastros de uma vez — zerar a contagem de todo mundo, e a regra deixaria de
 * valer sem nada ficar vermelho.
 *
 * ## A decisão não é tomada aqui
 *
 * Quem decide entre avisar, anonimizar e não fazer nada é `decidirRetencao`, em
 * `core`, pura e com relógio por parâmetro. Aqui só se lê o banco e se executa
 * o que ela disser — inclusive o caso que mais importa, o de quem voltou depois
 * de avisado.
 */
export async function varrerRetencao(entrada: {
  readonly tenantId: string;
  readonly agora?: Date;
  /** Teto por volta. A fila roda de novo amanhã; travar o banco não. */
  readonly limite?: number;
}): Promise<ResultadoDaVarredura> {
  const agora = entrada.agora ?? new Date();
  const limite = entrada.limite ?? 200;
  const corte = new Date(agora.getTime() - RETENCAO_ANOS * 365 * 86_400_000);

  return withTenant(entrada.tenantId, async (tx) => {
    /**
     * Quem voltou perde o carimbo do aviso — e a `/security-review` deste bloco
     * foi quem cobrou.
     *
     * A consulta abaixo só enxerga quem está **além** do corte, então quem
     * voltou some dela e o carimbo antigo ficava para sempre. Duas
     * consequências, e a segunda é grave:
     *
     * 1. o cliente continuava na lista "sai por inatividade" da tela, com data
     *    de saída no passado;
     * 2. se ele parasse de vir outra vez, cinco anos depois, `decidirRetencao`
     *    leria um `avisadoEm` de anos atrás, concluiria que o prazo venceu e
     *    **anonimizaria na primeira varredura** — pulando os trinta dias de
     *    aviso prévio que a SPEC §1.8 regra 6 exige antes de uma operação
     *    irreversível.
     *
     * O comentário da migração 0034 já prometia que "uma visita zera a
     * contagem". Isto é a promessa cumprida.
     */
    await tx.$executeRaw`
      UPDATE customers c
         SET retention_notified_at = NULL, updated_at = now()
       WHERE c.retention_notified_at IS NOT NULL
         AND c.anonymized_at IS NULL
         AND GREATEST(
               c.created_at,
               COALESCE((SELECT max(a.starts_at) FROM appointments a
                          WHERE a.customer_id = c.id), '-infinity'::timestamptz),
               COALESCE((SELECT max(o.opened_at) FROM orders o
                          WHERE o.customer_id = c.id), '-infinity'::timestamptz),
               COALESCE((SELECT max(l.created_at) FROM customer_ledger l
                          WHERE l.customer_id = c.id), '-infinity'::timestamptz),
               COALESCE((SELECT max(q.joined_at) FROM queue_entries q
                          WHERE q.customer_id = c.id), '-infinity'::timestamptz)
             ) > ${corte}
    `;

    const linhas = await tx.$queryRaw<
      {
        id: string;
        name: string;
        ultima_interacao: Date;
        retention_notified_at: Date | null;
      }[]
    >`
      SELECT c.id, c.name, c.retention_notified_at, u.ultima_interacao
        FROM customers c
        CROSS JOIN LATERAL (
          SELECT GREATEST(
            c.created_at,
            COALESCE((SELECT max(a.starts_at) FROM appointments a
                       WHERE a.customer_id = c.id), '-infinity'::timestamptz),
            COALESCE((SELECT max(o.opened_at) FROM orders o
                       WHERE o.customer_id = c.id), '-infinity'::timestamptz),
            COALESCE((SELECT max(l.created_at) FROM customer_ledger l
                       WHERE l.customer_id = c.id), '-infinity'::timestamptz),
            COALESCE((SELECT max(q.joined_at) FROM queue_entries q
                       WHERE q.customer_id = c.id), '-infinity'::timestamptz)
          ) AS ultima_interacao
        ) u
       WHERE c.anonymized_at IS NULL
         AND u.ultima_interacao <= ${corte}
       ORDER BY u.ultima_interacao
       LIMIT ${limite}
    `;

    const avisados: CadastroParado[] = [];
    const paraAnonimizar: string[] = [];

    for (const linha of linhas) {
      const passo: PassoDaRetencao = decidirRetencao(
        {
          ultimaInteracao: linha.ultima_interacao,
          avisadoEm: linha.retention_notified_at,
          anonimizadoEm: null,
        },
        agora,
      );

      if (passo === 'avisar') {
        avisados.push({
          customerId: linha.id,
          nome: linha.name,
          ultimaInteracao: linha.ultima_interacao,
          avisadoEm: null,
        });
      } else if (passo === 'anonimizar') {
        paraAnonimizar.push(linha.id);
      }
    }

    if (avisados.length > 0) {
      // Um `UPDATE` para o lote inteiro: um por cliente seria o N+1 de volta
      // pela porta dos fundos.
      await tx.$executeRaw`
        UPDATE customers SET retention_notified_at = ${agora}, updated_at = now()
         WHERE id = ANY(${avisados.map((a) => a.customerId)}::uuid[])
      `;
    }

    let anonimizados = 0;
    for (const customerId of paraAnonimizar) {
      /**
       * Um por vez, e não um `UPDATE` em lote.
       *
       * A anonimização toca oito tabelas e é irreversível: uma linha que falhe
       * não pode arrastar as outras trinta e nove para trás nem, pior, deixar
       * metade do trabalho feito. Cada uma é uma chamada à função do banco, que
       * é atômica por construção.
       */
      const resultado = await anonimizarCliente({
        tenantId: entrada.tenantId,
        customerId,
        motivo: `retenção: sem interação há ${RETENCAO_ANOS} anos`,
        ator: { id: null, name: 'Retenção automática' },
        tx,
      });
      if (resultado.anonimizado) anonimizados += 1;
    }

    return { avisados, anonimizados };
  });
}

/**
 * Quem já foi avisado e ainda não saiu — o "aviso prévio ao tenant" da SPEC.
 *
 * A tela é o canal. A regra 6 pede aviso prévio e não diz por onde: uma
 * mensagem que ninguém lê cumpriria a letra e não a intenção, e a lista aberta
 * na tela de privacidade é onde o dono decide se corre atrás de alguém.
 *
 * Só leitura: quem carimba `retention_notified_at` é a varredura, de madrugada.
 * Se esta consulta avisasse, abrir a tela mudaria o prazo — e a data do aviso
 * passaria a depender de alguém ter olhado.
 */
export async function aVencerPorRetencao(
  tenantId: string,
): Promise<readonly CadastroParado[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { id: string; name: string; retention_notified_at: Date }[]
    >`
      SELECT id, name, retention_notified_at
        FROM customers
       WHERE anonymized_at IS NULL AND retention_notified_at IS NOT NULL
       ORDER BY retention_notified_at
       LIMIT 200
    `;

    return linhas.map((l) => ({
      customerId: l.id,
      nome: l.name,
      // A data que interessa na tela é a do aviso: é dela que os trinta dias
      // contam. A última interação é o que **motivou** o aviso e já passou.
      ultimaInteracao: l.retention_notified_at,
      avisadoEm: l.retention_notified_at,
    }));
  });
}

export type { PassoDaRetencao };
