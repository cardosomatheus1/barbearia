import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  CONFIANCA_MINIMA,
  definicaoDaMetrica,
  formatarMetrica,
  METRICAS,
  PERGUNTAS_SUGERIDAS,
  interpretadorLocal,
  periodoDaInterpretacao,
  SEM_ROTULO,
  validarPergunta,
  type ChaveDeMetrica,
  type FalhaDaPergunta,
} from '@barbearia/core';
import { medir, rentabilidadeDoClube } from '@barbearia/finance';
import { churnDaBase } from '@barbearia/crm';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import {
  Exige,
  PermissaoGuard,
  exigirLimiteDoSuporte,
  exigirSegundoFator,
} from './permissao.guard.js';
import { conversaSchema, perguntaSchema } from './metrica.schemas.js';
import { unidadeDoBalcao } from './unidade.js';

/**
 * O schema semântico de métricas (bloco 63, SPEC §4.15).
 *
 * ## Uma rota para dezenas de perguntas, e por isso a permissão não mora nela
 *
 * Toda outra rota deste produto declara o que devolve. Esta devolve coisas
 * diferentes conforme o que foi perguntado — e é justamente o desenho que a SPEC
 * pede: *"um conjunto fechado de métricas e dimensões validadas"*.
 *
 * A saída é que a permissão viaja **com a métrica**, no catálogo de `core`, e é
 * conferida contra as permissões que a pessoa tem **no banco**. `@Exige` aqui
 * declara só o piso: saber que a pessoa é da casa. Sem isso, o assistente seria
 * o caminho mais curto para tudo que o painel guarda — a recepção perguntaria o
 * faturamento e receberia, porque a rota estaria declarada com a permissão de
 * *conversar*.
 *
 * Ela é conferida **duas** vezes: no domínio, para a mensagem ser honesta ("você
 * não tem acesso a este número" é diferente de "não entendi a pergunta"), e aqui,
 * porque validação de domínio não é guarda de rota e a de baixo não confia na de
 * cima.
 *
 * ## `POST`, e não `GET`
 *
 * A pergunta é um objeto com quatro campos validados, e o bloco 64 vai mandar o
 * texto original junto. Ela também **não** é cacheável nem deve entrar no
 * histórico do navegador: "quanto faturei" numa URL fica no autocompletar, no
 * referrer e no log do proxy — é o precedente do código de erro que não nomeia o
 * mecanismo, do bloco 60.
 */
@Controller('v1/admin/metricas')
@UseGuards(StaffGuard, PermissaoGuard)
export class MetricaController {
  /**
   * O catálogo, recortado pelo que **esta** pessoa pode perguntar.
   *
   * Devolver a lista inteira e deixar a tela esconder seria a permissão
   * recalculada na view, que este código proíbe desde o bloco 30 — e diria à
   * recepção que existe um número de faturamento que ela não pode ver, que é
   * informação por si.
   *
   * O piso é `appointments.view`, e é de propósito o mais baixo que existe.
   *
   * A tentação é `reports.operational`, que soa como "quem lê relatório" — e ela
   * fecharia o assistente para a recepção inteira, que é justamente quem mais
   * ganharia com "quantos faltaram hoje". Pior: ela **esconderia o desenho**,
   * porque a rota passaria a barrar por conta própria e ninguém notaria se a
   * permissão da métrica parasse de ser conferida.
   *
   * O piso responde só "esta pessoa é da casa e olha a operação". Quem decide o
   * que ela pode perguntar é o catálogo, uma métrica de cada vez.
   */
  @Exige('appointments.view')
  @Get()
  async catalogo(@Staff() staff: AuthenticatedStaff) {
    /**
     * As permissões saem da **sessão**, que as resolveu de `role_permissions`.
     *
     * Não é um mapa no código: papel é editável pelo dono desde o bloco 30, e
     * `staff.permissions` é o mesmo conjunto que a `PermissaoGuard` aplica. Uma
     * segunda consulta aqui seria N+1 sobre o que a guarda já leu.
     */
    const minhas = new Set(staff.permissions);
    const posso = (chave: ChaveDeMetrica) =>
      definicaoDaMetrica(chave).exige.every((p) => minhas.has(p));

    return {
      metricas: METRICAS.filter((m) => posso(m.chave)).map((m) => ({
        chave: m.chave,
        rotulo: m.rotulo,
        significado: m.significado,
        unidade: m.unidade,
        dimensoes: m.dimensoes,
        tela: m.tela,
        subirEBom: m.subirEBom,
      })),
      sugestoes: PERGUNTAS_SUGERIDAS.filter((s) => posso(s.metrica)),
    };
  }

  /**
   * A pergunta em português (bloco 64, SPEC §4.15).
   *
   * O tradutor só produz um **palpite**: métrica, dimensão e período. O caminho
   * dali para o número é exatamente o mesmo de `perguntar` — a mesma validação,
   * a mesma permissão, o mesmo executor. É isso que faz o tradutor não ser a
   * fronteira de segurança: ele pode errar, ser enganado por um texto malicioso
   * ou um dia ser um modelo de linguagem, e nada disso alcança o banco.
   *
   * Não entendeu? Responde as sugestões, e não um palpite. Um número que parece
   * certo para a pergunta errada é o pior desfecho possível aqui.
   */
  @Exige('appointments.view')
  @Post('conversar')
  async conversar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(conversaSchema)) body: { texto: string },
  ) {
    const palpite = interpretadorLocal.interpretar(body.texto);
    if (!palpite || palpite.confianca < CONFIANCA_MINIMA) {
      return {
        entendi: false as const,
        /**
         * As sugestões saem recortadas pelo que a pessoa pode, como o catálogo.
         *
         * Oferecer "quanto faturei" a quem levaria 403 é o botão que só dá erro
         * — e aqui ele ensinaria a recepção a achar que o produto está quebrado.
         */
        sugestoes: PERGUNTAS_SUGERIDAS.filter((s) =>
          definicaoDaMetrica(s.metrica).exige.every((p) => staff.permissions.includes(p)),
        ),
      };
    }

    const periodo = periodoDaInterpretacao(palpite, new Date());
    const resposta = await this.perguntar(staff, {
      metrica: palpite.metrica,
      dimensao: palpite.dimensao,
      ...periodo,
    });
    return { entendi: true as const, confianca: palpite.confianca, ...resposta };
  }

  @Exige('appointments.view')
  @Post('perguntar')
  async perguntar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(perguntaSchema))
    body: { metrica: string; dimensao: string; de: string; ate: string },
  ) {
    /**
     * As permissões saem do **banco**, nunca do pedido.
     *
     * É a regra de "ninguém concede o que não tem", do bloco 30: o que o ator
     * pode foi lido de `role_permissions` ao abrir a sessão, e não de um campo
     * que o cliente mandou. Num assistente isso é ainda mais importante, porque
     * o corpo da requisição um dia vai ser montado por um modelo — e modelo não
     * é fronteira de segurança.
     */
    const validada = validarPergunta(body, staff.permissions);
    if (!validada.ok) {
      /**
       * `sem_permissao` responde 403; o resto responde 400.
       *
       * As duas mensagens são diferentes de propósito: "não entendi a pergunta"
       * mandaria a pessoa reformular para sempre um número que ela nunca poderá
       * ver.
       */
      throw new DomainError(
        validada.falha,
        validada.falha === 'sem_permissao' ? 403 : 400,
        MENSAGEM[validada.falha],
      );
    }

    const { pergunta, definicao } = validada;

    /**
     * As **três** derivações da guarda, e não só a de permissão.
     *
     * O piso desta rota é o mais baixo que existe, de propósito — quem decide é
     * o catálogo, uma métrica de cada vez. O que a primeira versão não viu é que
     * a `PermissaoGuard` deriva outras duas decisões da mesma lista do `@Exige`:
     * o limite da sessão de suporte e o segundo fator do dinheiro. Com
     * `appointments.view` declarado, as duas ficavam desligadas — e uma pergunta
     * sobre faturamento saía sem TOTP, e a sessão de suporte da plataforma lia o
     * caixa da barbearia, que é justamente o que `PERMISSOES_DO_SUPORTE` diz que
     * ela não vê.
     *
     * A permissão viaja com **o que foi perguntado**, então as outras duas têm
     * que viajar junto. São as mesmas funções que a guarda chama: uma segunda
     * cópia da regra seria a lista paralela que este código proíbe.
     */
    exigirLimiteDoSuporte(staff, definicao.exige);
    exigirSegundoFator(staff, definicao.exige);

    const unidade = await unidadeDoBalcao(staff);
    const resposta = await responder(staff.tenantId, pergunta, unidade.id);

    return {
      /** O número, o período, a fonte e onde conferir — os quatro da SPEC §4.15. */
      metrica: pergunta.metrica,
      rotulo: definicao.rotulo,
      significado: definicao.significado,
      de: pergunta.de,
      ate: pergunta.ate,
      dimensao: pergunta.dimensao,
      unidade: definicao.unidade,
      subirEBom: definicao.subirEBom,
      tela: definicao.tela,
      total: resposta.total,
      totalFormatado: formatarMetrica(resposta.total, definicao.unidade),
      fatias: resposta.fatias.map((f) => ({
        // A fatia sem nome diz o que é — ver `SEM_ROTULO`. Célula em branco ao
        // lado de um valor é o número mentindo por omissão.
        rotulo: f.rotulo ?? SEM_ROTULO[pergunta.dimensao],
        valor: f.valor,
        formatado: formatarMetrica(f.valor, definicao.unidade),
      })),
    };
  }
}

/**
 * `Record` da união, e não `Record<string, string>`.
 *
 * Com a chave larga o acesso devolve `string | undefined`, e `noUncheckedIndexedAccess`
 * reclamou — que é o certo: o mapa parcial devolveria `undefined` como mensagem
 * numa falha nova, e o balcão veria uma caixa de erro em branco. Com a união, o
 * compilador cobra a frase no dia em que a falha nova existir.
 */
const MENSAGEM: Record<FalhaDaPergunta, string> = {
  metrica_desconhecida: 'Esta pergunta não está entre as que o produto sabe responder.',
  dimensao_nao_suportada: 'Esta métrica não pode ser quebrada dessa forma.',
  periodo_invalido: 'Confira o período: ele vai até um ano e as datas precisam existir.',
  sem_permissao: 'Você não tem acesso a este número.',
};

/**
 * Onde cada métrica é medida.
 *
 * Duas moram fora de `finance` — `clientes_em_risco` é `packages/crm` —, e a
 * composição acontece aqui pela mesma razão do bloco 62: `finance` não pode
 * depender de `crm`, e reescrever a definição em qualquer um dos dois faria o
 * assistente discordar da tela sobre o mesmo número.
 */
async function responder(
  tenantId: string,
  pergunta: { metrica: ChaveDeMetrica; dimensao: string; de: string; ate: string },
  locationId: string,
): Promise<{ total: number | null; fatias: readonly { rotulo: string | null; valor: number | null }[] }> {
  if (pergunta.metrica === 'rentabilidade_do_clube') {
    /**
     * A margem do clube em pontos-base, sobre a receita do período.
     *
     * O cálculo é o de `rentabilidadeDoClube` — comissão do modelo escolhido e
     * insumo congelado no movimento —, e ele **não** é refeito aqui: o
     * assistente e a tela do clube precisam responder o mesmo número.
     */
    const clube = await rentabilidadeDoClube({ tenantId, de: pergunta.de, ate: pergunta.ate });
    return {
      total:
        clube.receitaCents > 0
          ? Math.round((clube.margemCents / clube.receitaCents) * 10_000)
          : null,
      fatias: [],
    };
  }

  if (pergunta.metrica === 'clientes_em_risco') {
    const todos = await churnDaBase(tenantId);
    return { total: todos.filter((c) => c.faixa !== 'baixo').length, fatias: [] };
  }

  return medir({
    tenantId,
    metrica: pergunta.metrica,
    dimensao: pergunta.dimensao as never,
    de: pergunta.de,
    ate: pergunta.ate,
    locationId,
  });
}
