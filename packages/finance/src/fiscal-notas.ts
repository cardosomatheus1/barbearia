import { sql, withTenant, type TransactionClient } from '@barbearia/db';
import {
  baseDaNota,
  comissaoDoPeriodo,
  ESTADOS_QUE_OCUPAM_A_VENDA,
  motivoParaNaoEmitir,
  parteDoParceiro,
  type EstadoDaNota,
  type FaixaDeComissao,
  type ModoDeComissao,
  type RegimeFiscal,
} from '@barbearia/core';
import { enfileirarPara } from '@barbearia/jobs';
import { inteiroSeguroDoBanco } from './inteiro-seguro.js';
import { configuracaoFiscal } from './fiscal-configuracao.js';
import { recusar } from './fiscal-erros.js';
import { modoFiscal } from './fiscal-emissor.js';

export interface NotaNaTela {
  readonly id: string;
  readonly orderId: string;
  readonly estado: EstadoDaNota;
  readonly numero: string | null;
  readonly linkPdf: string | null;
  readonly motivoDaRecusa: string | null;
  readonly regime: RegimeFiscal;
  readonly servicoCents: number;
  readonly issBps: number;
  readonly clienteNome: string | null;
  readonly pedidaEm: string;
  readonly criadaPor: string;
}

/** A mesma nota, para quem pode ver a comissão de todo mundo. */
export interface NotaComRepartição extends NotaNaTela {
  readonly parceiroCents: number;
  /** O que fica com a casa. Derivado, e mostrado junto para não obrigar à conta. */
  readonly casaCents: number;
}

const paraTela = (l: {
  id: string;
  order_id: string;
  status: EstadoDaNota;
  number: string | null;
  pdf_url: string | null;
  rejection_reason: string | null;
  regime: RegimeFiscal;
  service_cents: number;
  partner_cents: number;
  iss_bps: number;
  customer_name: string | null;
  requested_at: Date;
  created_by_name: string;
}): NotaNaTela => ({
  id: l.id,
  orderId: l.order_id,
  estado: l.status,
  numero: l.number,
  linkPdf: l.pdf_url,
  motivoDaRecusa: l.rejection_reason,
  regime: l.regime,
  servicoCents: l.service_cents,
  issBps: l.iss_bps,
  clienteNome: l.customer_name,
  pedidaEm: l.requested_at.toISOString(),
  criadaPor: l.created_by_name,
});

const COLUNAS = sql`id, order_id, status::text AS status, number, pdf_url, rejection_reason,
                    regime::text AS regime, service_cents, partner_cents, iss_bps,
                    customer_name, requested_at, created_by_name`;

export async function notasDoPeriodo(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly de: string;
  readonly ate: string;
  /**
   * Só quem tem `commission.view_all` recebe a repartição.
   *
   * A rota decide, e o padrão é **não**: um parâmetro que precisasse ser passado
   * para esconder faria toda chamada nova nascer vazando.
   */
  readonly comRepartição?: boolean;
  /**
   * Quem chama pode ver identidade de cliente (`customers.view`).
   *
   * Obrigatório e não opcional: opcional, ele seria esquecido no primeiro
   * chamador novo e o nome do tomador sairia para quem a barbearia decidiu não
   * dar — que é a polaridade oposta de `comRepartição` acima, e é de propósito:
   * lá o padrão é **não mostrar**, aqui não existe padrão.
   *
   * Redigir e não recusar: o nome do tomador é a única coisa pessoal desta
   * listagem, e somá-lo ao `@Exige` trancava um papel "Contador" — que tem
   * `fiscal.view` e `finance.view` e não precisa de ficha de cliente — para
   * fora de "as notas do mês saíram?", que é a pergunta inteira daquela tela.
   */
  readonly podeVerCliente: boolean;
}): Promise<readonly (NotaNaTela | NotaComRepartição)[]> {
  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<Parameters<typeof paraTela>[0][]>(sql`
      SELECT ${COLUNAS}
        FROM fiscal_invoices
       WHERE location_id = ${params.locationId}::uuid
         AND requested_at >= ${params.de}::date
         AND requested_at < (${params.ate}::date + 1)
       ORDER BY requested_at DESC
       LIMIT 500
    `);
    return linhas.map((l) => {
      const nota = params.podeVerCliente
        ? paraTela(l)
        : { ...paraTela(l), clienteNome: null };
      return params.comRepartição
        ? {
            ...nota,
            parceiroCents: l.partner_cents,
            casaCents: l.service_cents - l.partner_cents,
          }
        : nota;
    });
  });
}

export async function notaDaVenda(
  tenantId: string,
  locationId: string,
  orderId: string,
  tx?: TransactionClient,
): Promise<NotaNaTela | null> {
  const dentro = async (t: TransactionClient) => {
    // A RLS separa barbearias e não separa lojas: `notasDoPeriodo` e `pedirNota`
    // já recortavam por unidade, e as três funções por id ficaram para trás.
    const linhas = await t.$queryRaw<Parameters<typeof paraTela>[0][]>(sql`
      SELECT ${COLUNAS}
        FROM fiscal_invoices
       WHERE order_id = ${orderId}::uuid AND location_id = ${locationId}::uuid
       ORDER BY requested_at DESC
       LIMIT 1
    `);
    const linha = linhas[0];
    return linha ? paraTela(linha) : null;
  };
  return tx ? dentro(tx) : withTenant(tenantId, dentro);
}

/**
 * Cria a nota **pendente** e enfileira o envio.
 *
 * Roda dentro da transação que fecha a comanda quando a emissão é automática, e
 * sozinha quando o balcão pede à mão. A tarefa nasce **na mesma transação** que
 * a linha: enfileirar depois do commit abriria a janela em que a nota consta
 * pendente e nada está marcado para enviá-la — é o precedente de `finance` e
 * `platform` dependerem de `jobs` só por `enfileirarPara()`.
 *
 * O valor sai de fatos já congelados: a base é a soma dos **serviços** da
 * comanda, e a parte do parceiro é a comissão daquela venda. Nenhum dos dois é
 * recalculado depois.
 */
export async function pedirNota(
  tx: TransactionClient,
  params: {
    readonly tenantId: string;
    readonly locationId: string;
    readonly orderId: string;
    readonly staffId: string | null;
    readonly staffName: string;
    /** Quando `true`, a ausência de configuração ou de serviço é silêncio. */
    readonly automatica: boolean;
  },
): Promise<{ readonly id: string } | null> {
  /**
   * Sem emissor no ambiente, não existe nota a pedir.
   *
   * A guarda vem **antes** de tudo porque criar a linha `pendente` seria o
   * defeito inteiro: a fila a pegaria, falaria com um emissor que não existe, e
   * ela ficaria em `processando` para sempre — com o cliente tendo pedido nota
   * fiscal e a tela dizendo que está a caminho.
   *
   * Automática é **silêncio**, e é obrigatório que seja: `pedirNota` roda dentro
   * de `fecharComanda`, que por sua vez roda na transação do webhook do Pix.
   * Uma exceção ali volta atrás com o dinheiro sem registro nenhum — é a lição
   * do bloco 35, e ela vale aqui inteira.
   *
   * O modo sai do ambiente, como `modoDoAdquirente` em `packages/platform`:
   * enfiá-lo por parâmetro obrigaria `fecharComanda` a conhecer o emissor para
   * repassá-lo, e ela não deve conhecer.
   */
  if (modoFiscal() === 'nenhum') {
    if (params.automatica) return null;
    recusar('fiscal_indisponivel');
  }

  const config = await configuracaoFiscal(params.tenantId, params.locationId, tx);

  const vendas = await tx.$queryRaw<
    {
      status: 'open' | 'paid' | 'cancelled' | 'refunded';
      customer_name: string | null;
      customer_document: string | null;
    }[]
  >`
    -- O CPF sai do cadastro e é congelado na nota, como o nome já era. Lê-lo do
    -- cadastro na hora de enviar faria a nota de janeiro mudar de tomador
    -- quando o cliente corrigisse o próprio documento em março.
    SELECT o.status::text AS status, c.name AS customer_name, c.tax_id AS customer_document
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = ${params.orderId}::uuid AND o.location_id = ${params.locationId}::uuid
  `;
  const venda = vendas[0];
  if (!venda) {
    if (params.automatica) return null;
    recusar('venda_nao_encontrada');
  }

  const itens = await tx.$queryRaw<{ tipo: string; total: bigint }[]>`
    SELECT kind::text AS tipo, sum(quantity::bigint * unit_price_cents)::bigint AS total
      FROM order_items
     WHERE order_id = ${params.orderId}::uuid
     GROUP BY kind
  `;
  const servicoCents = baseDaNota(itens.map((i) => ({
    tipo: i.tipo,
    totalCents: inteiroSeguroDoBanco(i.total, `base fiscal ${i.tipo}`),
  })));

  // A lista sai de `core` porque o índice parcial que a impõe diz exatamente
  // isto. Escrita à mão aqui, ela já discordou dele em `cancelando`.
  const jaTem = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM fiscal_invoices
     WHERE order_id = ${params.orderId}::uuid
       AND status::text = ANY(${[...ESTADOS_QUE_OCUPAM_A_VENDA]}::text[])
  `;

  const impedimento = motivoParaNaoEmitir({
    temConfiguracao: config !== null,
    // À mão, a emissão acontece mesmo com o automático desligado: é o caminho
    // para a barbearia que emite só quando o cliente pede.
    emitirAutomaticamente: params.automatica ? (config?.emitirAutomaticamente ?? false) : true,
    servicoCents,
    estadoDaVenda: venda.status,
    jaTemNota: jaTem.length > 0,
  });
  if (impedimento) {
    if (params.automatica) return null;
    recusar('nao_emite', impedimento);
  }
  if (!config) {
    if (params.automatica) return null;
    recusar('nao_configurado');
  }

  /**
   * A comissão daquela venda é a parte do parceiro.
   *
   * A mesma fonte do split, e por isso não existe alíquota de parceiro em lugar
   * nenhum do schema. Só os lançamentos positivos entram: um estorno lançado
   * depois não muda a nota que já foi emitida.
   */
  const lancamentos = await tx.$queryRaw<
    {
      id: string;
      professional_id: string;
      rule_id: string | null;
      mode: ModoDeComissao;
      value: number;
      tiers: FaixaDeComissao[];
      base_cents: number;
      sign: number;
    }[]
  >`
    SELECT id, professional_id, rule_id, mode, value, tiers, base_cents, sign
      FROM commission_entries
     WHERE order_id = ${params.orderId}::uuid AND sign = 1
  `;
  /**
   * A conta é de `packages/core`, nunca do SQL.
   *
   * A primeira versão somava a comissão dentro da consulta com um `CASE`, e o
   * `mode = 'tiers'` caía no `ELSE 0`: uma barbearia com faixa progressiva
   * emitia toda nota de Salão-Parceiro com a parcela do profissional zerada —
   * número errado num documento fiscal, sem nada ficar vermelho. É a regra que o
   * `CLAUDE.md` já escreve desde o bloco 44, e a revisão deste bloco a pegou de
   * novo.
   *
   * A faixa progressiva depende do acumulado do período, e uma nota é de **uma**
   * venda: o que se soma aqui é a comissão daquela venda isolada, que é o que a
   * lei manda separar. `comissaoDoPeriodo` sobre os lançamentos desta comanda dá
   * exatamente isso.
   */
  const contas = comissaoDoPeriodo(
    lancamentos.map((l) => ({
      itemId: l.id,
      professionalId: l.professional_id,
      regraId: l.rule_id ?? 'sem-regra',
      modo: l.mode,
      valor: l.value,
      faixas: l.tiers,
      baseCents: l.base_cents,
      sinal: l.sign as 1 | -1,
    })),
  );
  const parceiroCents = parteDoParceiro({
    regime: config.regime,
    comissaoCents: contas.reduce((soma, c) => soma + c.comissaoCents, 0),
    servicoCents,
  });

  const criadas = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO fiscal_invoices
      (tenant_id, location_id, order_id, regime, service_cents, partner_cents,
       iss_bps, service_code, municipality_ibge, customer_name, customer_document,
       created_by, created_by_name)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${params.locationId}::uuid, ${params.orderId}::uuid,
      ${config.regime}::fiscal_regime, ${servicoCents}, ${parceiroCents},
      ${config.issBps}, ${config.codigoDeServico}, ${config.municipioIbge},
      ${venda.customer_name}, ${venda.customer_document},
      ${params.staffId}::uuid, ${params.staffName}
    )
    RETURNING id
  `;
  const criada = criadas[0];
  if (!criada) return null;

  await enfileirarPara(tx, params.tenantId, {
    kind: 'fiscal.emitir',
    // Id, nunca conteúdo: `jobs` não tem RLS, e o `payload` é legível sem tenant.
    payload: { invoiceId: criada.id },
    // Uma tarefa por nota: a reentrada do fechamento não enfileira a segunda.
    idempotencyKey: `fiscal:${criada.id}`,
  });

  return { id: criada.id };
}

/**
 * Envia a nota ao emissor e grava o que ele respondeu.
 *
 * Chamada **pela fila**, fora da transação que fechou a comanda. A chamada de
 * rede acontece com a linha já gravada: se o processo cair no meio, a nota
 * continua `pendente` e a próxima volta a reenvia — com a mesma chave, que faz o
 * emissor devolver a primeira em vez de emitir a segunda.
 */
