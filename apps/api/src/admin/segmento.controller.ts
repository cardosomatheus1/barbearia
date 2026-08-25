import { Controller, Get, UseGuards } from '@nestjs/common';
import { segmentosNaTela } from '@barbearia/crm';
import { ROTULO_DO_SEGMENTO, SEGMENTOS } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';

/**
 * A leitura de segmentação da base (bloco 61, SPEC §4.4).
 *
 * ## Por que `customers.view_notes` acompanha `customers.view`
 *
 * A rota devolve classificação de relacionamento e uma lista de pessoas em
 * risco. Isso é exatamente a camada que a ficha chama de **anotação/insight do
 * cliente**: esconder o segmento em `/clientes` e entregá-lo aqui só com
 * `customers.view` transformaria a rota agregada num bypass da permissão.
 *
 * `finance.view` continua desnecessária porque nenhum valor em reais atravessa;
 * `customers.view_notes` protege a inferência e o contexto de relacionamento.
 */
@Controller('v1/admin/segments')
@UseGuards(StaffGuard, PermissaoGuard)
export class SegmentoController {
  @Exige('customers.view', 'customers.view_notes')
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
