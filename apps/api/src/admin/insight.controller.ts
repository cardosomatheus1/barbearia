import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  CORTE_CHEIO_BPS,
  MAXIMO_DE_INSIGHTS,
  montarInsights,
  type HoraOciosa,
} from '@barbearia/core';
import { agendasApertadas, getAvailabilityRange, servicoMaisVendido } from '@barbearia/scheduling';
import { contarPorSegmento, segmentosDaBase } from '@barbearia/crm';
import { medir } from '@barbearia/finance';
import { diaNaUnidade } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { unidadeDoBalcao } from './unidade.js';

/**
 * Os insights proativos (bloco 67, SPEC §4.19).
 *
 * > *"O sistema identifica situações sem ser perguntado."*
 *
 * ## Este controller é o ponto de encontro, e é onde ele tinha que ser
 *
 * O insight cruza agenda (`scheduling`), base de clientes (`crm`) e caixa
 * (`finance`) — três pacotes que não se conhecem, e cujas setas não podem voltar
 * para se conhecerem. Quem os junta é a camada de cima, como já acontece no
 * heatmap do bloco 57. A decisão de **o que vira insight e em que ordem** não
 * está aqui: mora em `packages/core`, pura, onde o teste alcança.
 *
 * ## Três permissões, e a que menos parece necessária é a que decide
 *
 * `customers.view` cobre a contagem de quem está no ponto de voltar.
 * `finance.view` está aqui porque o cartão traz **dinheiro**: o impacto é o
 * ticket médio multiplicado por uma contagem, e uma contagem multiplicada por
 * ticket é faturamento por outro caminho — é a regra que a revisão do bloco 46
 * escreveu sobre a rota de assinantes por plano.
 *
 * E a da agenda é `appointments.view_all_professionals`, não `appointments.view`:
 * achado da `/security-review` deste bloco, e a **sexta** vez que a regra da rota
 * que agrega é quebrada aqui. O cartão nomeia o colega — *"João está com 97% de
 * ocupação e catorze pessoas entraram na lista de espera"* —, e isso é a agenda
 * da casa inteira, que `board` e `agenda` recortam desde sempre. Papel é editável
 * desde o bloco 30: bastaria a barbearia dar `finance.view` a um barbeiro sênior,
 * grant natural para ele ver o caixa do dia, e ele passaria a ler a comparação
 * entre colegas que a separação `commission.view_own` existe para evitar. O
 * padrão só o barrava por acidente, porque ele não tem `finance.view`.
 *
 * O custo é o segundo fator, que `finance.view` deriva. Ele é aceito porque
 * estes cartões moram no painel, que já o exige para a faixa de dinheiro: quem
 * abre o painel de manhã já provou o TOTP uma vez, e não haverá uma segunda
 * confirmação por causa desta rota.
 */
@Controller('v1/admin/insights')
@UseGuards(StaffGuard, PermissaoGuard)
export class InsightController {
  @Exige('appointments.view_all_professionals', 'customers.view', 'finance.view')
  @Get()
  async insights(@Staff() staff: AuthenticatedStaff) {
    const local = await unidadeDoBalcao(staff);
    const agora = new Date();
    const tenantId = staff.tenantId;

    const { dia: hoje } = diaNaUnidade(null, local.timezone, agora);
    const amanha = new Date(Date.parse(`${hoje}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);

    const [ticket, apertadas, segmentos, servicoId] = await Promise.all([
      /**
       * O ticket da janela de leitura, e não o de ontem.
       *
       * Um dia fraco derrubaria o impacto de todos os cartões ao mesmo tempo, e
       * a ordem — que é o que o limite de três usa — mudaria por ruído.
       */
      medir({
        tenantId,
        metrica: 'ticket_medio',
        dimensao: 'nenhuma',
        de: recuar(hoje, 56),
        ate: hoje,
        locationId: local.id,
      }),
      agendasApertadas({ tenantId, locationId: local.id, agora, corteBps: CORTE_CHEIO_BPS }),
      segmentosDaBase(tenantId, agora),
      servicoMaisVendido({ tenantId, locationId: local.id, agora }),
    ]);

    const horaOciosa = servicoId
      ? await this.vagasDeAmanha(tenantId, local.id, servicoId, amanha, segmentos)
      : null;

    return {
      insights: montarInsights(
        {
          ticketMedioCents: Math.round(ticket.total ?? 0),
          horaOciosa,
          apertadas,
        },
        MAXIMO_DE_INSIGHTS,
      ),
    };
  }

  /**
   * As vagas de amanhã, contadas **pelo motor**.
   *
   * `collapse` porque é assim que o cliente vê a grade quando não escolhe
   * barbeiro — o número do cartão é o mesmo que a página pública mostraria, e
   * não uma segunda noção de "horário livre". É a regra do bloco 65 aplicada a
   * uma leitura em vez de a uma conversa.
   */
  private async vagasDeAmanha(
    tenantId: string,
    locationId: string,
    servicoId: string,
    amanha: string,
    segmentos: Awaited<ReturnType<typeof segmentosDaBase>>,
  ): Promise<HoraOciosa | null> {
    const grade = await getAvailabilityRange({
      tenantId,
      locationId,
      serviceIds: [servicoId],
      dateFrom: amanha,
      collapse: true,
    });

    const slots = grade.days[0]?.slots ?? [];
    if (slots.length === 0) return null;

    const horas = slots.map((s) => Number(s.start.slice(0, 2)));

    /**
     * O público é o **mesmo** que a campanha vai alcançar.
     *
     * `em_risco` é "passou do ritmo dele", que é a frase da SPEC §4.19 em outras
     * palavras — e é o filtro que o botão do cartão abre. Contar aqui de um jeito
     * e mandar a campanha para outro conjunto faria o cartão prometer noventa e
     * seis e a campanha alcançar quarenta (§6, pergunta 6).
     */
    const porSegmento = contarPorSegmento(segmentos);

    return {
      vagas: slots.length,
      primeiraHora: Math.min(...horas),
      ultimaHora: Math.max(...horas),
      clientesNoPonto: porSegmento['em_risco'] ?? 0,
    };
  }
}

/** Recua dias no calendário, sobre a data já resolvida no fuso da unidade. */
const recuar = (dia: string, dias: number): string =>
  new Date(Date.parse(`${dia}T00:00:00Z`) - dias * 86_400_000).toISOString().slice(0, 10);
