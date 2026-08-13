import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { TETO_DE_VARIACAO_BPS, recomendarPrecos } from '@barbearia/core';
import {
  apagarFaixaDePreco,
  criarFaixaDePreco,
  faixasDaUnidade,
  horasMedidas,
  ligarPrecoPorFaixa,
} from '@barbearia/scheduling';
import { medir } from '@barbearia/finance';
import { diaNaUnidade } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import { faixaDePrecoSchema, precoPorFaixaSchema } from './precificacao.schemas.js';
import { unidadeDoBalcao } from './unidade.js';

/**
 * Preço por faixa de horário (bloco 68, SPEC §4.20).
 *
 * ## `settings.manage`, a mesma do preço do serviço
 *
 * Quem pode mudar o preço de um corte no catálogo pode mudar o preço da terça à
 * tarde: é a mesma decisão de política comercial, com o mesmo alcance. Inventar
 * uma permissão nova aqui criaria a caixa que ninguém concede — foi assim que
 * `feedback.view` ficou três blocos invisível na tela de permissões.
 *
 * `finance.discount` seria a escolha errada apesar do nome: ela diz quem pode
 * **abrir mão de receita numa venda**, com teto por comanda, e a recepção a tem.
 * Uma faixa de preço não é um desconto no balcão — é a tabela da casa.
 *
 * ## A rota de recomendação declara `finance.view` junto
 *
 * Ela devolve *"geraria ~R$ 1.240/mês"*, que é receita projetada a partir do
 * ticket médio da casa. É a mesma regra da rota de insights do bloco 67: uma
 * contagem multiplicada por ticket é faturamento por outro caminho.
 */
@Controller('v1/admin/precificacao')
@UseGuards(StaffGuard, PermissaoGuard)
export class PrecificacaoController {
  @Exige('settings.manage')
  @Get()
  async ler(@Staff() staff: AuthenticatedStaff) {
    const local = await unidadeDoBalcao(staff);
    return faixasDaUnidade(staff.tenantId, local.id);
  }

  /**
   * O interruptor, e ele é o que a SPEC chama de "autorização configurada
   * explicitamente".
   *
   * *"Nunca alterar preço automaticamente sem autorização configurada."* Sem
   * ele ligado, as faixas ficam cadastradas e não valem — que é o estado certo
   * para quem está montando a política e ainda não decidiu.
   */
  @Exige('settings.manage')
  @Put('ligado')
  async ligar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(precoPorFaixaSchema)) corpo: { ligado: boolean },
  ) {
    const local = await unidadeDoBalcao(staff);
    await ligarPrecoPorFaixa(staff.tenantId, local.id, corpo.ligado);
    return faixasDaUnidade(staff.tenantId, local.id);
  }

  @Exige('settings.manage')
  @Post('faixas')
  async criar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(faixaDePrecoSchema))
    corpo: { diaDaSemana: number; inicioMinuto: number; fimMinuto: number; deltaBps: number },
  ) {
    const local = await unidadeDoBalcao(staff);
    const criada = await criarFaixaDePreco({
      tenantId: staff.tenantId,
      locationId: local.id,
      staffUserId: staff.staffUserId,
      ...corpo,
    });
    if (!criada) {
      /**
       * A recusa da constraint de exclusão vira 409 com motivo, nunca 500.
       *
       * Entrada malformada que devolve 500 é defeito de borda, sempre — e aqui
       * a entrada é legítima: a pessoa cadastrou uma faixa que encosta noutra, e
       * precisa saber **isso**, não "erro interno".
       */
      throw new DomainError(
        'faixa_sobreposta',
        409,
        'Já existe uma faixa nesse dia e horário. Ajuste a que existe ou mude o intervalo.',
      );
    }
    return faixasDaUnidade(staff.tenantId, local.id);
  }

  @Exige('settings.manage')
  @Delete('faixas/:id')
  async apagar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    const local = await unidadeDoBalcao(staff);
    const apagada = await apagarFaixaDePreco(staff.tenantId, local.id, id);
    if (!apagada) {
      /**
       * Mesma mensagem de faixa inexistente, e é decisão.
       *
       * "Existe, mas é de outra loja" confirma o id para quem o adivinhou — é o
       * precedente do OTP, que responde igual para telefone existente e
       * inexistente, e a regra que o bloco 58 escreveu para unidade.
       */
      throw new DomainError('faixa_nao_encontrada', 404, 'Esta faixa não existe mais.');
    }
    return faixasDaUnidade(staff.tenantId, local.id);
  }

  /**
   * O que a casa **poderia** mudar — e é só isso.
   *
   * A recomendação é derivada da ocupação medida e não é gravada em lugar
   * nenhum: some no instante em que deixa de ser verdade, como o DRE e o
   * segmento. Não existe rota que a aplique sozinha, e a ausência é o bloco
   * inteiro: *"a IA recomenda, o administrador aprova"*.
   */
  @Exige('settings.manage', 'finance.view')
  @Get('recomendacoes')
  async recomendacoes(@Staff() staff: AuthenticatedStaff) {
    const local = await unidadeDoBalcao(staff);
    const agora = new Date();
    const { dia: hoje } = diaNaUnidade(null, local.timezone, agora);

    const [horas, ticket, faixas] = await Promise.all([
      horasMedidas({ tenantId: staff.tenantId, locationId: local.id, agora }),
      medir({
        tenantId: staff.tenantId,
        metrica: 'ticket_medio',
        dimensao: 'nenhuma',
        de: recuar(hoje, 56),
        ate: hoje,
        locationId: local.id,
      }),
      faixasDaUnidade(staff.tenantId, local.id),
    ]);

    /**
     * Hora que já tem faixa cadastrada não é recomendada de novo.
     *
     * O dono já decidiu ali. Repetir a sugestão sobre a decisão dele é a lista
     * que se aprende a ignorar — e a constraint de exclusão recusaria o cadastro
     * de qualquer jeito, então o botão levaria a um erro.
     */
    const jaDecidida = new Set(
      faixas.faixas.flatMap((f) => {
        const horasDaFaixa: string[] = [];
        for (let h = Math.floor(f.inicioMinuto / 60); h < Math.ceil(f.fimMinuto / 60); h += 1) {
          horasDaFaixa.push(`${f.diaDaSemana}-${h}`);
        }
        return horasDaFaixa;
      }),
    );

    return {
      recomendacoes: recomendarPrecos({
        horas: horas.filter((h) => !jaDecidida.has(`${h.diaDaSemana}-${h.hora}`)),
        ticketMedioCents: Math.round(ticket.total ?? 0),
        tetoBps: faixas.tetoBps || TETO_DE_VARIACAO_BPS,
      }),
    };
  }
}

/** Recua dias no calendário, sobre a data já resolvida no fuso da unidade. */
const recuar = (dia: string, dias: number): string =>
  new Date(Date.parse(`${dia}T00:00:00Z`) - dias * 86_400_000).toISOString().slice(0, 10);
