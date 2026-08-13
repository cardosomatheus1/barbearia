import { Controller, Get, UseGuards } from '@nestjs/common';
import { segmentosNaTela } from '@barbearia/crm';
import { ROTULO_DO_SEGMENTO, SEGMENTOS } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';

/**
 * A leitura de segmentação da base (bloco 61, SPEC §4.4).
 *
 * ## Por que `customers.view` e nada mais
 *
 * A rota devolve **contagem por segmento** e uma lista curta de quem está em
 * risco, com nome, ciclo e dias sem vir. Nenhum valor em reais atravessa: o
 * segmento é derivado de gasto entre outras coisas, mas o gasto em si é
 * `finance.view`, e devolvê-lo aqui seria o faturamento por cliente saindo de
 * uma rota chamada "segmentos" — a quarta vez que a regra da rota que agrega
 * seria quebrada neste repositório.
 *
 * A contagem sozinha também não é dinheiro: ao contrário de "quantos assinam
 * cada plano" (bloco 48), ela não tem preço para multiplicar. "Trinta em risco"
 * não vira faturamento por nenhuma conta.
 */
@Controller('v1/admin/segments')
@UseGuards(StaffGuard, PermissaoGuard)
export class SegmentoController {
  @Exige('customers.view')
  @Get()
  async ler(@Staff() staff: AuthenticatedStaff) {
    const dados = await segmentosNaTela(staff.tenantId);
    return {
      /**
       * A ordem e o rótulo saem do domínio, nunca da tela.
       *
       * Um `Object.entries` do mapa devolveria a ordem de escrita do objeto, que
       * ninguém garante e que mudaria com um `git merge`. `SEGMENTOS` é a mesma
       * lista que o domínio usa para decidir.
       */
      segmentos: SEGMENTOS.map((s) => ({
        chave: s,
        rotulo: ROTULO_DO_SEGMENTO[s],
        quantos: dados.contagem[s],
      })),
      emRisco: dados.emRisco,
    };
  }
}
