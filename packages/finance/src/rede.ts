import { withTenant } from '@barbearia/db';
import {
  consolidar,
  meuLugarNaRede,
  type MeuLugarNaRede,
  type Rede,
  type UnidadeDaRede,
} from '@barbearia/core';

/**
 * Indicadores consolidados e metas da rede (bloco 77).
 *
 * ## Por que aqui e não em `catalog`
 *
 * O que atravessa a fronteira entre franqueadora e franqueada é **dinheiro**:
 * receita, ticket e meta de faturamento. `finance` já é onde a comissão e o
 * desempenho do profissional moram, e a alternativa seria um pacote novo com
 * dois arquivos e a mesma dependência. O bloco 76 — cardápio — ficou em
 * `catalog` pela mesma lógica: lá o assunto é catálogo.
 *
 * ## Uma consulta, e ela atravessa a RLS de propósito
 *
 * `indicadores_da_franquia` é `SECURITY DEFINER` e é a única coisa deste produto
 * que lê o faturamento de outro tenant. As três guardas estão **dentro** dela:
 * a franquia é a do contexto (nunca um parâmetro), sem tenant não devolve nada,
 * e a identidade é redigida quando quem pergunta é franqueada.
 *
 * Deste lado não há filtro repetido, pela mesma razão de sempre: repetir mascara
 * guarda ausente. O que existe aqui é a conta — e ela é de `packages/core`.
 */

export class RedeError extends Error {
  constructor(
    readonly code: 'sem_franquia' | 'nao_e_franqueadora' | 'mes_invalido' | 'meta_invalida',
    message: string,
  ) {
    super(message);
    this.name = 'RedeError';
  }
}

export interface Periodo {
  /** YYYY-MM-DD, inclusivo nas duas pontas — é dia da unidade, não instante. */
  readonly de: string;
  readonly ate: string;
}

interface LinhaCrua {
  tenant_id: string | null;
  nome: string | null;
  eu: boolean;
  receita_cents: bigint | number;
  vendas: bigint | number;
  atendimentos: bigint | number;
  meta_cents: bigint | number | null;
}

async function carregar(tenantId: string, periodo: Periodo): Promise<readonly UnidadeDaRede[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<LinhaCrua[]>`
      SELECT tenant_id, nome, eu, receita_cents, vendas, atendimentos, meta_cents
        FROM indicadores_da_franquia(${periodo.de}::date, ${periodo.ate}::date)
    `;
    return linhas.map((l) => ({
      tenantId: l.tenant_id,
      nome: l.nome,
      eu: l.eu,
      receitaCents: Number(l.receita_cents),
      vendas: Number(l.vendas),
      atendimentos: Number(l.atendimentos),
      metaCents: l.meta_cents === null ? null : Number(l.meta_cents),
    }));
  });
}

/**
 * A rede nomeada, para a franqueadora.
 *
 * Se quem chamar for franqueada, a função SQL já devolve as linhas sem nome —
 * então esta rota não vaza nada por descuido de rota. O que ela devolveria é uma
 * lista de números anônimos, e por isso a recusa é explícita: uma tela com
 * quatro linhas em branco é pior que um erro.
 */
export async function redeDaFranqueadora(tenantId: string, periodo: Periodo): Promise<Rede> {
  const unidades = await carregar(tenantId, periodo);
  if (unidades.length === 0) {
    throw new RedeError('sem_franquia', 'Esta barbearia não é franqueadora de nenhuma rede');
  }
  /**
   * A prova de que quem pergunta é a franqueadora é **não estar na lista**.
   *
   * A função SQL devolve só as franqueadas, então a franqueadora nunca aparece
   * nela — e toda franqueada aparece, com `eu` verdadeiro na própria linha.
   *
   * A primeira versão inferia isso de outro jeito: "se alguma linha veio sem
   * nome, quem pergunta é franqueada". Numa rede com **uma** franqueada só, ela
   * mesma perguntando não encontraria linha redigida — a única que existe é a
   * dela, que vem nomeada — e passaria pela guarda. Não vazava nada, porque a
   * lista era ela própria; mas era uma guarda que dependia do tamanho da rede,
   * e a próxima leitura que alguém somasse aqui já não teria essa sorte.
   */
  if (unidades.some((u) => u.eu)) {
    throw new RedeError('nao_e_franqueadora', 'Só a franqueadora vê a rede nomeada');
  }
  return consolidar(unidades);
}

/**
 * Os próprios números contra a rede, para a franqueada.
 *
 * A lista crua **não sai daqui**: a rota devolve só o agregado. É a segunda
 * camada — a primeira é a redação da identidade dentro da função SQL —, e ela
 * existe porque uma rota nova que devolvesse `unidades` inteira entregaria os
 * faturamentos anônimos da rede, dos quais numa rede de quatro se deduz muita
 * coisa.
 */
export async function meuLugar(tenantId: string, periodo: Periodo): Promise<MeuLugarNaRede> {
  const unidades = await carregar(tenantId, periodo);
  const lugar = meuLugarNaRede(unidades);
  if (!lugar) {
    throw new RedeError('sem_franquia', 'Esta barbearia não é franqueada de nenhuma rede');
  }
  return lugar;
}

export interface MetaDaRede {
  readonly tenantId: string;
  readonly nome: string;
  readonly mes: string;
  readonly metaCents: number | null;
  /** A do mês anterior, para a tela sugerir sem decidir por ninguém. */
  readonly anteriorCents: number | null;
}

const primeiroDoMes = (mes: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mes)) {
    throw new RedeError('mes_invalido', 'Mês inválido');
  }
  return `${mes.slice(0, 7)}-01`;
};

/**
 * As metas do mês, com a do mês anterior ao lado.
 *
 * Sugere, não renova: é a decisão do bloco 22 para a meta do profissional, e
 * pelo mesmo motivo — renovação automática produz meta que ninguém combinou,
 * cobrada de quem não foi consultado. Aqui vale mais ainda, porque a franqueada
 * é outra empresa.
 */
export async function metasDaRede(tenantId: string, mes: string): Promise<readonly MetaDaRede[]> {
  const primeiro = primeiroDoMes(mes);

  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        tenant_id: string;
        nome: string;
        meta_cents: bigint | null;
        anterior_cents: bigint | null;
      }[]
    >`
      SELECT ft.tenant_id, tp.name AS nome,
             atual.revenue_cents AS meta_cents,
             passada.revenue_cents AS anterior_cents
        FROM franchise_tenants ft
        JOIN tenant_platform tp ON tp.tenant_id = ft.tenant_id
        LEFT JOIN franchise_goals atual
               ON atual.tenant_id = ft.tenant_id AND atual.month = ${primeiro}::date
        LEFT JOIN franchise_goals passada
               ON passada.tenant_id = ft.tenant_id
              AND passada.month = (${primeiro}::date - interval '1 month')::date
       WHERE ft.franchise_id = franquia_do_contexto()
         AND ft.role = 'franqueada'
       ORDER BY tp.name
    `;

    return linhas.map((l) => ({
      tenantId: l.tenant_id,
      nome: l.nome,
      mes: primeiro,
      metaCents: l.meta_cents === null ? null : Number(l.meta_cents),
      anteriorCents: l.anterior_cents === null ? null : Number(l.anterior_cents),
    }));
  });
}

/**
 * A franqueadora combina a meta de uma franqueada.
 *
 * Meta não é preço: combinar alvo de vendas é o contrato de franquia; dizer por
 * quanto vender é que não. Quem recusa a franqueada que tentar escrever é a
 * política de RLS, e a contagem de linhas afetadas é conferida aqui — um
 * `UPDATE` que não pegou ninguém devolvendo "salvo" é recusa silenciosa.
 */
export async function salvarMetaDaRede(entrada: {
  readonly tenantId: string;
  readonly franqueadaId: string;
  readonly mes: string;
  readonly metaCents: number;
}): Promise<void> {
  const primeiro = primeiroDoMes(entrada.mes);
  if (!Number.isInteger(entrada.metaCents) || entrada.metaCents <= 0) {
    throw new RedeError('meta_invalida', 'A meta precisa ser um valor positivo');
  }

  await withTenant(entrada.tenantId, async (tx) => {
    /**
     * O id da franqueada vem do corpo e é conferido **sob RLS antes de gravar**:
     * a checagem de integridade referencial do Postgres ignora row security, e
     * a chave estrangeira aceitaria o tenant de outra rede sem reclamar. Aqui a
     * conferência é a política de `franchise_tenants`, que só devolve a linha
     * de quem está na franquia do contexto — e o `INSERT ... SELECT` carrega o
     * `franchise_id` de lá em vez de recebê-lo de fora.
     */
    const gravadas = await tx.$executeRaw`
      INSERT INTO franchise_goals (franchise_id, tenant_id, month, revenue_cents)
      SELECT ft.franchise_id, ft.tenant_id, ${primeiro}::date, ${entrada.metaCents}
        FROM franchise_tenants ft
       WHERE ft.tenant_id = ${entrada.franqueadaId}::uuid
         AND ft.franchise_id = franquia_do_contexto()
         AND ft.role = 'franqueada'
      ON CONFLICT (tenant_id, month)
      DO UPDATE SET revenue_cents = EXCLUDED.revenue_cents, updated_at = now()
    `;

    if (gravadas === 0) {
      /**
       * Mesma mensagem de "não existe": "existe, mas não é da sua rede" confirma
       * o id para quem o adivinhou. É o precedente do OTP.
       */
      throw new RedeError('nao_e_franqueadora', 'Franqueada não encontrada nesta rede');
    }
  });
}
