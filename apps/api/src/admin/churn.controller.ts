import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { churnDaBase, contarPorSegmento, segmentosDaBase } from '@barbearia/crm';
import { crescimentoDaCasa } from '@barbearia/finance';
import { ROTULO_DA_FAIXA_DE_CHURN } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { janelaSchema } from './churn.schemas.js';
import { unidadeDoBalcao } from './unidade.js';

/**
 * O risco de abandono e o crescimento sobre série longa (bloco 62).
 *
 * ## Duas permissões, e por que a terceira ficou de fora
 *
 * A explicação de churn diz *"a última avaliação dele foi nota 2"* ao lado de um
 * nome — isso é mais preciso que a lista de avaliações, então `reviews.view`
 * entra junto de `customers.view`. É a regra da rota que agrega, quebrada quatro
 * vezes neste repositório.
 *
 * **`finance.view` não entra, e é decisão escrita.** Ela derivaria segundo fator
 * (o prefixo `finance.` é o que a `PermissaoGuard` lê), e esta é a tela que a
 * gerência abre de manhã e volta nela o dia todo — seriam trinta confirmações de
 * TOTP por dia numa tela que não move um centavo. É o mesmo argumento da
 * permissão fiscal do bloco 54.
 *
 * O que sustenta a decisão é que nenhum valor em reais atravessa, e que a lista
 * **não é a base**: só sai quem já está em risco médio ou alto. Uma listagem de
 * toda a base com "tem assinatura ativa" seria a contagem de assinantes por
 * outro caminho, e contagem de assinante vezes preço é faturamento — o defeito
 * que o bloco 48 nomeia.
 *
 * O crescimento é rota separada, com `reports.finance`: ali há receita por
 * cadeira e por hora, que é dinheiro.
 */
@Controller('v1/admin')
@UseGuards(StaffGuard, PermissaoGuard)
export class ChurnController {
  @Exige('customers.view', 'reviews.view')
  @Get('churn')
  async risco(@Staff() staff: AuthenticatedStaff) {
    const todos = await churnDaBase(staff.tenantId);
    const emRisco = todos.filter((c) => c.faixa !== 'baixo');
    return {
      clientes: emRisco.map((c) => ({
        customerId: c.customerId,
        nome: c.nome,
        risco: c.risco,
        faixa: c.faixa,
        rotuloDaFaixa: ROTULO_DA_FAIXA_DE_CHURN[c.faixa],
        motivos: c.motivos.map((m) => ({ sinal: m.sinal, frase: m.frase })),
        cicloDias: c.cicloDias,
        diasSemVir: c.diasSemVir,
      })),
      /**
       * Quantos foram avaliados ao todo, para o número em cima da lista não
       * mentir por omissão.
       *
       * "Doze em risco" sem o denominador não diz se a base tem quinze pessoas ou
       * mil e duzentas — é a regra do bloco 55 sobre número que ignora parte do
       * dado: ele sai completo, com cara de completo, e o dono decide em cima.
       */
      avaliados: todos.length,
    };
  }

  /**
   * As métricas de série longa e a linha de faturamento.
   *
   * **`finance.view` junto de `reports.finance`, e a primeira não é redundante.**
   *
   * `reports.finance` parece a permissão certa pelo nome, e sozinha ela seria um
   * buraco: o grupo que deriva segundo fator é `PERMISSOES_DE_DINHEIRO`, e ele
   * filtra por prefixo `finance.`/`cashier.` mais duas de comissão —
   * `reports.finance` **não está lá**. Declarada sozinha, esta rota devolveria
   * faturamento dia a dia, receita por cadeira e receita por hora sem nenhum
   * segundo fator, enquanto o DRE ao lado cobra TOTP para mostrar os mesmos
   * centavos.
   *
   * É por isso que o risco de abandono é **rota separada**: ali não passa
   * centavo nenhum, e a gerência abre aquela tela o dia inteiro.
   */
  @Exige('finance.view', 'reports.finance', 'customers.view')
  @Get('crescimento')
  async crescimento(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(janelaSchema)) query: { de: string; ate: string },
  ) {
    /**
     * Duas coisas acontecem aqui, e as duas são de borda.
     *
     * A **unidade** sai da sessão e não da consulta: é o desenho do bloco 58 — a
     * recepção escolhe a loja ao chegar e trabalha nela o dia inteiro, e um
     * recorte vindo da URL faria cada tela precisar lembrar de repassá-lo.
     *
     * E o **abandono** vem de `crm`: `finance` não pode depender dele, e
     * "perdido" depende da mediana dos intervalos de cada pessoa, que não cabe
     * numa cláusula SQL. Compor na borda é o mesmo desenho do worker, que recebe
     * `varrerRetencao` injetada no `Contexto`.
     */
    const unidade = await unidadeDoBalcao(staff);
    const base = await segmentosDaBase(staff.tenantId);
    const contagem = contarPorSegmento(base);
    const comRitmo = base.filter((c) => c.ciclo !== null).length;

    const numeros = await crescimentoDaCasa({
      tenantId: staff.tenantId,
      de: query.de,
      ate: query.ate,
      locationId: unidade.id,
      perdidos: contagem.perdido,
      comRitmo,
    });

    return numeros;
  }
}
