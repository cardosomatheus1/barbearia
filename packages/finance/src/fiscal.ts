import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  baseDaNota,
  chaveDaNota,
  comissaoDoPeriodo,
  decisaoDaEntregaDaNota,
  ESTADOS_NAO_TERMINAIS,
  ESTADOS_QUE_OCUPAM_A_VENDA,
  motivoParaNaoEmitir,
  documentoDoTomadorValido,
  normalizarCnpj,
  normalizarDocumento,
  parteDoParceiro,
  validarConfiguracaoFiscal,
  type ConfiguracaoFiscal,
  type EstadoDaNota,
  type FaixaDeComissao,
  type ModoDeComissao,
  FakeFiscalProvider,
  type FiscalProvider,
  type MotivoDeNaoEmitir,
  type RegimeFiscal,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { enfileirarPara } from '@barbearia/jobs';

/**
 * Fiscal, do banco para o emissor (bloco 53, SPEC §3.11).
 *
 * A regra municipal não mora aqui e não pode morar: é o emissor terceirizado que
 * sabe se Salvador exige RPS numerado. O que este arquivo faz é reunir o que a
 * nota precisa — a partir de fatos já congelados — e cuidar do estado dela.
 *
 * ## A emissão nunca bloqueia a venda
 *
 * A nota nasce `pendente` **dentro da transação que fecha a comanda**, e a
 * tarefa que a envia nasce junto. Chamar o emissor ali seria pendurar a
 * prefeitura na frente do balcão: ela pode levar minutos, pode estar fora do ar,
 * e o cliente está esperando o troco. É a mesma decisão do KYC no bloco 50 e do
 * aviso ao dono no bloco 28.
 *
 * ## `finance` e não um pacote próprio
 *
 * A nota sai de uma venda, e o que ela carrega — base de serviço, comissão do
 * parceiro — é o que `finance` já calcula. Um pacote separado teria que importar
 * `finance` inteiro para montar um pedido.
 */

/**
 * Quem decide se a casa emite nota, e por qual emissor.
 *
 * ## Por que uma função só, e não um `new` em cada processo
 *
 * É o desenho do adquirente, e pela mesma cicatriz: o produto tem **dois**
 * processos que falam com o emissor — a API, quando o balcão pede a nota, e o
 * worker, que a leva à prefeitura. Cada um escolhendo o seu significa que ligar
 * o emissor de verdade é lembrar de dois lugares, e o que acontece é ligar num e
 * esquecer no outro.
 *
 * Foi exatamente o estado em que este código estava: `new FakeFiscalProvider()`
 * fixo nos dois, sem interruptor nenhum.
 *
 * ## Por que o padrão é **não emitir**, e não o falso
 *
 * O falso é otimista de um jeito silencioso. Ele aceita o pedido e devolve
 * `processando` — então em produção o balcão pedia a nota, a fila rodava, e a
 * nota ficava **em `processando` para sempre**. Sem erro, sem log, sem alerta. O
 * cliente pediu nota fiscal, a tela disse "processando", e nada jamais chegou à
 * prefeitura.
 *
 * É o defeito da §6 pergunta 5 — indicador que nunca preenche — com consequência
 * fiscal. Com `nenhum`, a rota **recusa** e a tela diz que o recurso não está
 * disponível, que é a convenção deste repositório: *gatilho ou opção que ainda
 * não funciona aparece na tela marcado, nunca escondido.*
 *
 * ## E por que ele recusa o que não conhece
 *
 * `FISCAL_MODO=nfeio` — um emissor que alguém contratou e ninguém integrou —
 * cairia em "não emite" numa leitura permissiva, e o sintoma seria a barbearia
 * descobrindo pelo cliente que a nota não sai. Falhar alto na subida é
 * barulhento uma vez; o silêncio custa o mês inteiro de notas.
 */
export type ModoFiscal = 'nenhum' | 'fake';

export function modoFiscal(bruto = process.env['FISCAL_MODO']): ModoFiscal {
  if (bruto === undefined || bruto === '') return 'nenhum';
  if (bruto === 'nenhum' || bruto === 'fake') return bruto;
  throw new Error(
    `FISCAL_MODO inválido: ${bruto}. Use nenhum ou fake — ` +
      'não há emissor de verdade integrado, e inventar um nome não contrata nenhum.',
  );
}

/**
 * O emissor do processo, ou `null` quando a casa não emite.
 *
 * `null` e não um falso silencioso: quem chama tem que decidir o que fazer, e a
 * decisão certa é recusar com mensagem, não fingir que emitiu.
 */
export function emissorFiscal(modo = modoFiscal()): FiscalProvider | null {
  return modo === 'fake' ? new FakeFiscalProvider() : null;
}

export type FiscalRepoFailure =
  | 'cnpj_invalido'
  | 'regime_invalido'
  | 'codigo_de_servico_obrigatorio'
  | 'aliquota_invalida'
  | 'municipio_obrigatorio'
  | 'nao_configurado'
  | 'nota_nao_encontrada'
  | 'nota_nao_cancelavel'
  | 'motivo_obrigatorio'
  | 'venda_nao_encontrada'
  | 'nao_emite'
  | 'documento_invalido'
  | 'cliente_nao_encontrado'
  | 'fiscal_indisponivel';

export class FiscalError extends Error {
  constructor(
    readonly code: FiscalRepoFailure,
    message: string,
    readonly motivo?: MotivoDeNaoEmitir,
  ) {
    super(message);
    this.name = 'FiscalError';
  }
}

const MENSAGEM: Readonly<Record<FiscalRepoFailure, string>> = {
  cnpj_invalido: 'Confira o CNPJ.',
  regime_invalido: 'Escolha um regime.',
  codigo_de_servico_obrigatorio: 'Informe o código de serviço municipal.',
  aliquota_invalida: 'O ISS vai de 0 a 5%.',
  municipio_obrigatorio: 'Informe o código IBGE do município.',
  nao_configurado: 'Cadastre CNPJ e regime antes de emitir nota.',
  nota_nao_encontrada: 'Esta nota não existe.',
  nota_nao_cancelavel: 'Só uma nota autorizada pode ser cancelada.',
  motivo_obrigatorio: 'Escreva o motivo do cancelamento.',
  venda_nao_encontrada: 'Esta venda não existe.',
  nao_emite: 'Esta venda não gera nota.',
  documento_invalido: 'Confira o CPF ou o CNPJ.',
  cliente_nao_encontrado: 'Este cliente não existe.',
  /**
   * A frase diz o que é: não é erro da barbearia nem falha momentânea.
   *
   * "Tente de novo" mandaria a recepção repetir para sempre uma operação que
   * não existe neste ambiente, com o cliente esperando no balcão.
   */
  fiscal_indisponivel:
    'A emissão de nota não está disponível: nenhum emissor está configurado nesta instalação.',
};

function recusar(code: FiscalRepoFailure, motivo?: MotivoDeNaoEmitir): never {
  throw new FiscalError(code, MENSAGEM[code], motivo);
}

// ---------------------------------------------------------------------------
// A configuração
// ---------------------------------------------------------------------------

export interface ConfiguracaoNaTela extends ConfiguracaoFiscal {
  readonly inscricaoMunicipal: string | null;
  readonly contaNoEmissor: string | null;
}

export async function configuracaoFiscal(
  tenantId: string,
  locationId: string,
  tx?: TransactionClient,
): Promise<ConfiguracaoNaTela | null> {
  const dentro = async (t: TransactionClient) => {
    const linhas = await t.$queryRaw<
      {
        cnpj: string;
        regime: RegimeFiscal;
        service_code: string;
        iss_bps: number;
        municipality_ibge: string;
        municipal_registration: string | null;
        provider_account_id: string | null;
        auto_issue: boolean;
      }[]
    >`
      SELECT cnpj, regime::text AS regime, service_code, iss_bps, municipality_ibge,
             municipal_registration, provider_account_id, auto_issue
        FROM fiscal_settings
       WHERE location_id = ${locationId}::uuid
    `;
    const linha = linhas[0];
    if (!linha) return null;
    return {
      cnpj: linha.cnpj,
      regime: linha.regime,
      codigoDeServico: linha.service_code,
      issBps: linha.iss_bps,
      municipioIbge: linha.municipality_ibge,
      emitirAutomaticamente: linha.auto_issue,
      inscricaoMunicipal: linha.municipal_registration,
      contaNoEmissor: linha.provider_account_id,
    };
  };
  return tx ? dentro(tx) : withTenant(tenantId, dentro);
}

export async function salvarConfiguracaoFiscal(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly config: ConfiguracaoFiscal;
  readonly inscricaoMunicipal?: string | null;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<ConfiguracaoNaTela> {
  const config = { ...params.config, cnpj: normalizarCnpj(params.config.cnpj) };
  const falha = validarConfiguracaoFiscal(config);
  if (falha) recusar(falha);

  return withTenant(params.tenantId, async (tx) => {
    const antes = await configuracaoFiscal(params.tenantId, params.locationId, tx);

    // A unidade vem do servidor, mas a conferência sob RLS fica: a chave
    // estrangeira aceitaria a de outra barbearia, porque a checagem referencial
    // ignora row security.
    const gravadas = await tx.$executeRaw`
      INSERT INTO fiscal_settings
        (location_id, tenant_id, cnpj, regime, service_code, iss_bps,
         municipality_ibge, municipal_registration, auto_issue, updated_by)
      SELECT ${params.locationId}::uuid,
             NULLIF(current_setting('app.tenant_id', true), '')::uuid,
             ${config.cnpj}, ${config.regime}::fiscal_regime,
             ${config.codigoDeServico.trim()}, ${config.issBps},
             ${config.municipioIbge}, ${params.inscricaoMunicipal?.trim() || null},
             ${config.emitirAutomaticamente}, ${params.staffId}::uuid
       WHERE EXISTS (SELECT 1 FROM locations WHERE id = ${params.locationId}::uuid)
      ON CONFLICT (location_id) DO UPDATE SET
        cnpj = EXCLUDED.cnpj,
        regime = EXCLUDED.regime,
        service_code = EXCLUDED.service_code,
        iss_bps = EXCLUDED.iss_bps,
        municipality_ibge = EXCLUDED.municipality_ibge,
        municipal_registration = EXCLUDED.municipal_registration,
        auto_issue = EXCLUDED.auto_issue,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
    `;
    if (gravadas === 0) recusar('nao_configurado');

    /**
     * Auditado porque **muda o que sai em nome da casa**.
     *
     * Não carrega centavo, e por isso fica na trilha de gestão e não na de
     * dinheiro: o que ele guarda é CNPJ, regime e alíquota. A pergunta que
     * responde — "quem mudou o regime para MEI?" — é de quem administra a
     * barbearia, e é a que aparece quando o contador acha uma nota errada.
     */
    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'fiscal.settings_changed',
      entity: 'fiscal_settings',
      entityId: params.locationId,
      ...(antes
        ? {
            before: {
              cnpj: antes.cnpj,
              regime: antes.regime,
              issBps: antes.issBps,
              emitirAutomaticamente: antes.emitirAutomaticamente,
            },
          }
        : {}),
      after: {
        cnpj: config.cnpj,
        regime: config.regime,
        issBps: config.issBps,
        emitirAutomaticamente: config.emitirAutomaticamente,
      },
    });

    const salva = await configuracaoFiscal(params.tenantId, params.locationId, tx);
    if (!salva) recusar('nao_configurado');
    return salva;
  });
}

// ---------------------------------------------------------------------------
// A nota
// ---------------------------------------------------------------------------

/**
 * A nota como a recepção a vê.
 *
 * **Sem `parceiroCents`**, e é a correção mais importante da `/security-review`
 * deste bloco. No Salão-Parceiro aquela parcela **é** a comissão do profissional
 * naquela venda — o mesmo dado que `commission.view_all` guarda e que o segundo
 * fator protege. Devolvê-la sob `fiscal.view`, que a recepcionista tem por
 * padrão, entregava a folha inteira de quem quisesse percorrer os ids das
 * comandas do dia.
 *
 * Não é campo escondido: é **outra forma**, para outro público, como a projeção
 * do self-service do clube no bloco 47. Quem tem `commission.view_all` lê a
 * parcela em `NotaComRepartição`, e a pergunta da recepção — "a nota do cliente
 * saiu?" — é respondida inteira por esta.
 */
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

const COLUNAS = `id, order_id, status::text AS status, number, pdf_url, rejection_reason,
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
}): Promise<readonly (NotaNaTela | NotaComRepartição)[]> {
  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRawUnsafe<Parameters<typeof paraTela>[0][]>(
      `SELECT ${COLUNAS}
         FROM fiscal_invoices
        WHERE location_id = $1::uuid
          AND requested_at >= $2::date
          AND requested_at < ($3::date + 1)
        ORDER BY requested_at DESC
        LIMIT 500`,
      params.locationId,
      params.de,
      params.ate,
    );
    return linhas.map((l) =>
      params.comRepartição
        ? {
            ...paraTela(l),
            parceiroCents: l.partner_cents,
            casaCents: l.service_cents - l.partner_cents,
          }
        : paraTela(l),
    );
  });
}

export async function notaDaVenda(
  tenantId: string,
  orderId: string,
  tx?: TransactionClient,
): Promise<NotaNaTela | null> {
  const dentro = async (t: TransactionClient) => {
    const linhas = await t.$queryRawUnsafe<Parameters<typeof paraTela>[0][]>(
      `SELECT ${COLUNAS}
         FROM fiscal_invoices
        WHERE order_id = $1::uuid
        ORDER BY requested_at DESC
        LIMIT 1`,
      orderId,
    );
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

  const itens = await tx.$queryRaw<{ tipo: string; total: number }[]>`
    SELECT kind::text AS tipo, sum(quantity * unit_price_cents)::int AS total
      FROM order_items
     WHERE order_id = ${params.orderId}::uuid
     GROUP BY kind
  `;
  const servicoCents = baseDaNota(itens.map((i) => ({ tipo: i.tipo, totalCents: i.total })));

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
export async function enviarNota(params: {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly provider: FiscalProvider;
}): Promise<EstadoDaNota> {
  const pedido = await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        order_id: string;
        status: EstadoDaNota;
        service_cents: number;
        partner_cents: number;
        iss_bps: number;
        service_code: string;
        municipality_ibge: string;
        customer_name: string | null;
        customer_document: string | null;
      }[]
    >`
      SELECT order_id, status::text AS status, service_cents, partner_cents, iss_bps,
             service_code, municipality_ibge, customer_name, customer_document
        FROM fiscal_invoices
       WHERE id = ${params.invoiceId}::uuid AND status = 'pendente'
       FOR UPDATE
    `;
    const nota = linhas[0];
    if (!nota) return null;

    // `processando` antes da chamada, pelo mesmo motivo de `liquidando` no bloco
    // 50: a trava cai no commit e a chamada de rede acontece fora dela. Sem o
    // estado, a volta seguinte da fila reenviaria a mesma nota.
    await tx.$executeRaw`
      UPDATE fiscal_invoices SET status = 'processando' WHERE id = ${params.invoiceId}::uuid
    `;

    const itens = await tx.$queryRaw<
      { description: string; quantity: number; unit_price_cents: number }[]
    >`
      SELECT description, quantity, unit_price_cents
        FROM order_items
       WHERE order_id = ${nota.order_id}::uuid AND kind = 'service'
       ORDER BY position
    `;

    return { nota, itens };
  });

  /**
   * Nada a enviar: ou a nota já saiu de `pendente`, ou ela está `processando`
   * desde a volta anterior. No segundo caso o que falta é **perguntar**, e é o
   * que este caminho faz.
   *
   * A primeira versão devolvia `processando` aqui e parava. O laço de
   * conciliação existia no papel — a tarefa se reprogramava — e nunca perguntava
   * nada à prefeitura: a nota ficava "na prefeitura" para sempre, que é o
   * indicador que nunca preenche do `CLAUDE.md` §6. Achado da revisão deste
   * bloco.
   */
  if (!pedido) return consultarNota(params);

  const resposta = await params.provider.emitir({
    invoiceId: params.invoiceId,
    orderId: pedido.nota.order_id,
    tenantId: params.tenantId,
    tomador: {
      nome: pedido.nota.customer_name ?? 'Consumidor',
      documento: pedido.nota.customer_document,
      email: null,
    },
    itens: pedido.itens.map((i) => ({
      descricao: i.description,
      quantidade: i.quantity,
      valorUnitarioCents: i.unit_price_cents,
    })),
    servicoCents: pedido.nota.service_cents,
    parceiroCents: pedido.nota.partner_cents,
    issBps: pedido.nota.iss_bps,
    codigoDeServico: pedido.nota.service_code,
    municipioIbge: pedido.nota.municipality_ibge,
  });

  await gravarResposta({
    tenantId: params.tenantId,
    invoiceId: params.invoiceId,
    resposta,
  });

  return resposta.estado;
}

/**
 * Pergunta à prefeitura o que aconteceu com uma nota que já foi enviada.
 *
 * É a rede de segurança da conciliação, e o único caminho pelo qual uma nota
 * sai de `processando`: a resposta municipal chega minutos ou horas depois, sem
 * webhook.
 */
async function consultarNota(params: {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly provider: FiscalProvider;
}): Promise<EstadoDaNota> {
  const linhas = await withTenant(params.tenantId, (tx) =>
    tx.$queryRaw<{ status: EstadoDaNota; provider_invoice_id: string | null }[]>`
      SELECT status::text AS status, provider_invoice_id FROM fiscal_invoices
       WHERE id = ${params.invoiceId}::uuid
    `,
  );
  const nota = linhas[0];
  if (!nota) return 'cancelada';
  // Sem id no emissor a nota nunca chegou lá: nada a consultar, e a próxima
  // volta da fila a reenvia.
  if (nota.status !== 'processando' || !nota.provider_invoice_id) return nota.status;

  const resposta = await params.provider.consultar(nota.provider_invoice_id);
  await gravarResposta({
    tenantId: params.tenantId,
    invoiceId: params.invoiceId,
    resposta,
  });
  return resposta.estado;
}

/**
 * Grava o que o emissor respondeu.
 *
 * Separada porque a varredura de conciliação usa a mesma escrita: a prefeitura
 * responde depois, e é `consultar` que traz o desfecho. Duas gravações
 * diferentes para o mesmo fato acabariam divergindo no primeiro campo novo.
 */
export async function gravarResposta(params: {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly resposta: {
    readonly estado: EstadoDaNota;
    readonly notaId: string;
    readonly numero: string | null;
    readonly linkPdf: string | null;
    readonly motivoDaRecusa: string | null;
  };
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    const autorizada = params.resposta.estado === 'autorizada';
    await tx.$executeRaw`
      UPDATE fiscal_invoices
         SET status = ${params.resposta.estado}::fiscal_invoice_status,
             provider_invoice_id = ${params.resposta.notaId},
             number = ${params.resposta.numero},
             pdf_url = ${params.resposta.linkPdf},
             rejection_reason = ${params.resposta.motivoDaRecusa},
             authorized_at = CASE WHEN ${autorizada} THEN now() ELSE authorized_at END
       WHERE id = ${params.invoiceId}::uuid
         AND status::text = ANY(${[...ESTADOS_NAO_TERMINAIS]}::text[])
    `;
  });
}

/** As notas que ainda esperam resposta da prefeitura. */
export async function notasEmCurso(
  tenantId: string,
  limite = 50,
): Promise<readonly { readonly id: string; readonly providerInvoiceId: string | null }[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string; provider_invoice_id: string | null }[]>`
      SELECT id, provider_invoice_id FROM fiscal_invoices
       WHERE status::text = ANY(${[...ESTADOS_NAO_TERMINAIS]}::text[])
       ORDER BY requested_at
       LIMIT ${limite}
    `;
    return linhas.map((l) => ({ id: l.id, providerInvoiceId: l.provider_invoice_id }));
  });
}

export async function cancelarNota(params: {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly motivo: string;
  readonly provider: FiscalProvider;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<void> {
  const motivo = params.motivo.trim();
  if (motivo.length < 3) recusar('motivo_obrigatorio');

  /**
   * O estado **em voo** vem antes da chamada, e é a lição do bloco 50.
   *
   * A trava do `FOR UPDATE` cai no commit, e a viagem à prefeitura acontece fora
   * da transação. Sem `cancelando`, dois toques em "Cancelar" leem `autorizada`
   * os dois e mandam o cancelamento duas vezes: o segundo bate contra um RPS já
   * cancelado, e o operador recebe "falhou" sobre uma nota que de fato foi
   * cancelada — com só uma das duas tentativas na trilha. Achado da
   * `/security-review` deste bloco.
   */
  const alvo = await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { status: EstadoDaNota; provider_invoice_id: string | null; number: string | null }[]
    >`
      SELECT status::text AS status, provider_invoice_id, number
        FROM fiscal_invoices
       WHERE id = ${params.invoiceId}::uuid
       FOR UPDATE
    `;
    const nota = linhas[0];
    if (!nota) recusar('nota_nao_encontrada');
    if (nota.status !== 'autorizada') recusar('nota_nao_cancelavel');

    const tomadas = await tx.$executeRaw`
      UPDATE fiscal_invoices SET status = 'cancelando'
       WHERE id = ${params.invoiceId}::uuid AND status = 'autorizada'
    `;
    if (tomadas !== 1) recusar('nota_nao_cancelavel');
    return nota;
  });

  try {
    if (alvo.provider_invoice_id) {
      await params.provider.cancelar(alvo.provider_invoice_id, motivo);
    }
  } catch (erro) {
    /**
     * O emissor recusou: a nota volta a `autorizada`.
     *
     * Deixá-la em `cancelando` a prenderia num estado sem saída na interface —
     * exatamente o defeito que a §6 do `CLAUDE.md` cataloga. Voltar é seguro
     * porque nada foi cancelado do outro lado.
     */
    await withTenant(params.tenantId, async (tx) => {
      await tx.$executeRaw`
        UPDATE fiscal_invoices SET status = 'autorizada'
         WHERE id = ${params.invoiceId}::uuid AND status = 'cancelando'
      `;
    });
    throw erro;
  }

  await withTenant(params.tenantId, async (tx) => {
    const canceladas = await tx.$executeRaw`
      UPDATE fiscal_invoices
         SET status = 'cancelada', cancelled_at = now(), cancel_reason = ${motivo}
       WHERE id = ${params.invoiceId}::uuid AND status = 'cancelando'
    `;
    if (canceladas !== 1) recusar('nota_nao_cancelavel');

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'fiscal.invoice_cancelled',
      entity: 'fiscal_invoice',
      entityId: params.invoiceId,
      before: { numero: alvo.number },
      after: { motivo },
    });
  });
}

export { chaveDaNota };

// ---------------------------------------------------------------------------
// A operação da nota (bloco 54)
// ---------------------------------------------------------------------------

/**
 * O CPF do tomador, guardado no cadastro do cliente.
 *
 * Mora em `customers` e não na comanda porque quem informa "põe meu CPF" o
 * informa **uma vez** — perguntar a cada visita é a diferença entre um cadastro
 * e um formulário. A nota congela o valor no momento da emissão, então corrigir
 * o documento depois não reescreve nota nenhuma.
 *
 * Auditado: é dado pessoal de identificação, e a pergunta que chega quando o
 * contador acha uma nota no CPF errado é "quem digitou isto?".
 */
export async function salvarDocumentoDoCliente(params: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly documento: string | null;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly documento: string | null }> {
  const documento = normalizarDocumento(params.documento);
  if (!documentoDoTomadorValido(documento)) recusar('documento_invalido');

  return withTenant(params.tenantId, async (tx) => {
    const antes = await tx.$queryRaw<{ tax_id: string | null }[]>`
      SELECT tax_id FROM customers WHERE id = ${params.customerId}::uuid FOR UPDATE
    `;
    if (!antes[0]) recusar('cliente_nao_encontrado');

    await tx.$executeRaw`
      UPDATE customers
         SET tax_id = ${documento}, updated_at = now()
       WHERE id = ${params.customerId}::uuid
    `;

    /**
     * A trilha guarda **se** havia documento, nunca qual era.
     *
     * `audit_log` é append-only e legível por quem administra a barbearia: pôr
     * o CPF ali criaria uma segunda cópia do dado que a anonimização não
     * alcança — e a trilha é justamente a tabela que a exportação do titular
     * deixa de fora por trazer nome de terceiros.
     */
    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'customers.tax_id_changed',
      entity: 'customers',
      entityId: params.customerId,
      before: { tinha: antes[0].tax_id !== null },
      after: { tinha: documento !== null },
    });

    return { documento };
  });
}

export interface NotaAEntregar {
  readonly id: string;
  readonly linkPdf: string;
  readonly numero: string | null;
  readonly telefone: string;
  readonly clienteNome: string;
  readonly timeZone: string;
  /** O nome da casa, que é como a mensagem se apresenta. */
  readonly barbearia: string;
}

/**
 * As notas autorizadas que ainda não chegaram ao cliente.
 *
 * O filtro diz a mesma coisa que o índice parcial `fiscal_invoices_a_entregar`:
 * autorizada, com link, sem carimbo de entrega. Escritos separados, os dois
 * divergiriam — é o defeito que o bloco 53 teve entre a lista da aplicação e o
 * índice de nota viva.
 *
 * O telefone entra no `JOIN` e não numa segunda consulta: sem ele não há
 * entrega, e uma ida ao banco por nota dentro do laço é o N+1 que a regra
 * proíbe.
 */
export async function notasAEntregar(
  tenantId: string,
  limite = 50,
): Promise<readonly NotaAEntregar[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        pdf_url: string;
        number: string | null;
        phone_e164: string;
        name: string;
        timezone: string;
        barbearia: string;
      }[]
    >`
      SELECT f.id, f.pdf_url, f.number, c.phone_e164, c.name, l.timezone,
             t.name AS barbearia
        FROM fiscal_invoices f
        JOIN orders o ON o.id = f.order_id
        JOIN customers c ON c.id = o.customer_id
        JOIN locations l ON l.id = f.location_id
        JOIN tenants t ON t.id = f.tenant_id
       WHERE f.status = 'autorizada'
         AND f.customer_notified_at IS NULL
         AND f.pdf_url IS NOT NULL
         AND c.phone_e164 IS NOT NULL
       ORDER BY f.authorized_at
       LIMIT ${limite}
    `;
    return linhas.map((l) => ({
      id: l.id,
      linkPdf: l.pdf_url,
      numero: l.number,
      telefone: l.phone_e164,
      clienteNome: l.name,
      timeZone: l.timezone,
      barbearia: l.barbearia,
    }));
  });
}

/**
 * Carimba a entrega, e devolve se **esta** chamada foi quem entregou.
 *
 * O carimbo é gravado antes de a mensagem sair, e a ordem é deliberada: a
 * alternativa — mandar e depois carimbar — perde o carimbo se o processo cair
 * no meio, e a volta seguinte da fila remanda a mesma nota. Entre repetir a
 * mensagem e não mandá-la, o produto escolhe não mandar: o link continua na
 * tela da comanda, e a recepção manda quando o cliente pedir.
 *
 * `customer_notified_at IS NULL` no `WHERE` é o que impede a segunda entrega
 * quando dois workers pegam a mesma nota — e a contagem é conferida, porque um
 * `UPDATE` que não pegou ninguém significa que outro já mandou.
 */
export async function marcarNotaEntregue(params: {
  readonly tenantId: string;
  readonly invoiceId: string;
}): Promise<boolean> {
  return withTenant(params.tenantId, async (tx) => {
    const carimbadas = await tx.$executeRaw`
      UPDATE fiscal_invoices
         SET customer_notified_at = now()
       WHERE id = ${params.invoiceId}::uuid
         AND status = 'autorizada'
         AND customer_notified_at IS NULL
    `;
    return carimbadas === 1;
  });
}

/**
 * Entrega as notas autorizadas de uma barbearia (bloco 54).
 *
 * Roda **pela fila**, uma volta por barbearia por hora. Cada nota decide
 * sozinha em `packages/core` — a janela de silêncio é do fuso da unidade, e o
 * horário do laço é UTC.
 *
 * Uma consulta para o conjunto e nenhuma dentro do laço: o telefone, o nome e o
 * fuso já vêm no `JOIN`. O laço só carimba e manda.
 *
 * O carimbo vem **antes** da mensagem, e é a decisão que importa aqui: mandar e
 * depois carimbar perde o carimbo se o processo cair, e a volta seguinte
 * remanda a mesma nota. Entre repetir e não mandar, o produto escolhe não
 * mandar — o link continua na comanda, e a recepção manda quando o cliente
 * pedir. A escolha inversa transformaria uma queda do worker em vinte
 * mensagens iguais no celular do cliente.
 */
export async function entregarNotasAutorizadas(params: {
  readonly tenantId: string;
  readonly agora: Date;
  readonly enviar: (mensagem: {
    readonly phoneE164: string;
    readonly barbearia: string;
    readonly numero: string | null;
    readonly link: string;
  }) => Promise<void>;
}): Promise<{ readonly enviadas: number; readonly adiadas: number }> {
  const notas = await notasAEntregar(params.tenantId);
  let enviadas = 0;
  let adiadas = 0;

  for (const nota of notas) {
    const decisao = decisaoDaEntregaDaNota({
      estado: 'autorizada',
      linkPdf: nota.linkPdf,
      entregueEm: null,
      telefone: nota.telefone,
      agora: params.agora,
      timeZone: nota.timeZone,
    });

    /**
     * Fora da janela de silêncio, a nota fica para a volta seguinte.
     *
     * Sem carimbo: ela precisa continuar na fila. `quando` é o instante em que
     * ela poderia sair, e compará-lo com agora é o mesmo que perguntar "estamos
     * dentro da janela?" — só que a resposta sai de `core`, onde o teste
     * alcança e onde o fuso da unidade é lido.
     */
    if (!decisao.entregar || !decisao.quando || decisao.quando.getTime() > params.agora.getTime()) {
      adiadas += 1;
      continue;
    }

    const nossa = await marcarNotaEntregue({ tenantId: params.tenantId, invoiceId: nota.id });
    if (!nossa) continue;

    await params.enviar({
      phoneE164: nota.telefone,
      barbearia: nota.barbearia,
      numero: nota.numero,
      link: nota.linkPdf,
    });
    enviadas += 1;
  }

  return { enviadas, adiadas };
}

export interface TomadorDaVenda {
  readonly customerId: string | null;
  readonly nome: string | null;
  readonly documento: string | null;
}

/**
 * Quem é o tomador desta venda, e qual documento ele tem hoje.
 *
 * A tela da comanda precisa disto para mostrar o campo de CPF preenchido — e
 * `notaDaVenda` não serve: ela devolve o que foi **congelado** numa nota que
 * pode nem existir ainda, e o que o balcão edita é o cadastro.
 *
 * Comanda avulsa devolve tudo nulo, e é estado legítimo: não há cliente, então
 * não há onde guardar CPF, e a tela diz isso em vez de mostrar um campo que não
 * salva em lugar nenhum.
 */
export async function tomadorDaVenda(
  tenantId: string,
  orderId: string,
): Promise<TomadorDaVenda | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { customer_id: string | null; name: string | null; tax_id: string | null }[]
    >`
      SELECT o.customer_id, c.name, c.tax_id
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.id = ${orderId}::uuid
    `;
    const linha = linhas[0];
    if (!linha) return null;
    return { customerId: linha.customer_id, nome: linha.name, documento: linha.tax_id };
  });
}
