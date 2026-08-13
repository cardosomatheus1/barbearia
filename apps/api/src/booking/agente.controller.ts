import { Body, Controller, Inject, Param, Post } from '@nestjs/common';
import {
  CONFIANCA_PARA_AGIR,
  horarioServe,
  interpretarPedido,
  oQueFalta,
  PERGUNTA_DO_AGENTE,
  type PedidoDoCliente,
} from '@barbearia/core';
import { getAvailabilityRange, getPublicProfile } from '@barbearia/scheduling';
import { notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { TenantService } from '../tenant/tenant.service.js';
import { slugSchema } from './booking.schemas.js';
import { conversaDoClienteSchema } from './agente.schemas.js';

/**
 * O agente de agendamento (bloco 65, SPEC §4.16).
 *
 * > *"O agente **nunca** calcula disponibilidade sozinho — sempre chama o motor.
 * > Uma única fonte de verdade."*
 *
 * Esta rota é a prova disso: ela interpreta a frase, e depois chama
 * `getAvailabilityRange` — **o mesmo** motor que a página pública usa, com a
 * mesma antecedência mínima, a mesma jornada e a mesma constraint
 * anti-overbooking. Não há uma segunda noção de "horário livre" neste código, e
 * não pode passar a haver.
 *
 * ## Ela não grava nada
 *
 * *"Confirmação explícita antes de gravar, com serviço, profissional, data, hora
 * e valor."* O que sai daqui é uma **proposta**. Gravar continua sendo o `POST`
 * de agendamento que já existe, com `Idempotency-Key`, sinal, score e tudo mais
 * — o agente não tem atalho para dentro da agenda.
 *
 * ## Sem autenticação, como o resto da superfície pública
 *
 * O slug é o endereço. E por isso a rota **não** devolve nada do cadastro: ela
 * responde sobre a grade, que já é pública. É o precedente de
 * `resolveGuestCustomer` — uma rota pública que reencontra cliente por telefone
 * viraria oráculo, e esta não reencontra ninguém.
 */
@Controller('v1/b/:slug/agente')
export class AgenteController {
  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  @Post()
  async conversar(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
    @Body(new ZodValidationPipe(conversaDoClienteSchema)) body: { texto: string },
  ) {
    const tenantId = await this.tenants.resolve(slug);
    if (!tenantId) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');

    const perfil = await getPublicProfile(tenantId, slug);
    if (!perfil) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');

    /**
     * O catálogo vem do perfil público, e é ele que impede o agente de inventar.
     *
     * *"Nunca inventa serviço, preço, horário ou promoção."* O intérprete casa
     * contra esta lista; o que não está nela vira nulo, e nulo faz perguntar.
     *
     * O cardápio vem achatado das categorias — é lá que o serviço mora no perfil
     * público, e o agente precisa da lista, não do agrupamento.
     */
    const servicos = perfil.categories.flatMap((c) =>
      c.services.map((s) => ({ id: s.id, nome: s.name })),
    );
    const pedido = interpretarPedido(body.texto, {
      servicos,
      profissionais: perfil.professionals.map((p) => ({ id: p.id, nome: p.name })),
    });

    if (!pedido) return { entendi: false as const, escalar: false as const };

    if (pedido.intencao === 'falar_com_humano') {
      /**
       * Pedir para falar com gente é uma **intenção**, não uma falha.
       *
       * Tratar como "não entendi" seria o agente insistindo com quem já desistiu
       * dele — e é o oposto da escalada que a SPEC exige.
       */
      return { entendi: true as const, escalar: true as const, intencao: pedido.intencao };
    }

    /**
     * Remarcar e cancelar não passam por aqui.
     *
     * Os dois exigem saber **qual** agendamento, e isso exige sessão — a rota de
     * remarcação já existe, com a grade que ignora o próprio horário e a fila de
     * espera disparada no cancelamento. Duplicar aqui seria uma segunda porta
     * para a mesma escrita, com metade das garantias.
     */
    if (pedido.intencao !== 'marcar') {
      return {
        entendi: true as const,
        escalar: false as const,
        intencao: pedido.intencao,
        precisaEntrar: true as const,
      };
    }

    const falta = oQueFalta(pedido);
    if (falta.length > 0 || pedido.confianca < CONFIANCA_PARA_AGIR) {
      /**
       * Uma pergunta por vez, e a mais importante primeiro.
       *
       * Perguntar duas coisas numa mensagem faz a pessoa responder uma e o
       * agente ficar no mesmo lugar.
       */
      const primeira = falta[0];
      return {
        entendi: true as const,
        escalar: false as const,
        intencao: pedido.intencao,
        pergunta: primeira ? PERGUNTA_DO_AGENTE[primeira] : PERGUNTA_DO_AGENTE.dia,
        entendido: resumo(pedido),
      };
    }

    /**
     * "Amanhã" é amanhã **na barbearia**, não em UTC.
     *
     * Às 22h em Rio Branco já é o dia seguinte em UTC: somar 24 horas ao instante
     * e cortar o ISO daria depois de amanhã. É a mesma razão de o fuso vir sempre
     * da unidade e nunca do aparelho — o defeito D2 do sistema analisado.
     */
    const dia = diaLocal(new Date(), perfil.location.timezone, pedido.emQuantosDias ?? 0);

    const grade = await getAvailabilityRange({
      tenantId,
      locationId: perfil.location.id,
      serviceIds: [pedido.servicoId!],
      dateFrom: dia,
      ...(pedido.profissionalId ? { professionalId: pedido.profissionalId } : {}),
      collapse: !pedido.profissionalId,
    });

    /**
     * A faixa pedida recorta o que o motor devolveu — nunca o contrário.
     *
     * O motor decide o que **existe**; o pedido decide o que **serve**. Filtrar
     * antes seria o agente calculando agenda, que é exatamente o que a SPEC
     * proíbe.
     */
    const doDia = grade.days[0];
    const servem = (doDia?.slots ?? []).filter((s) =>
      horarioServe(pedido, {
        inicioMinuto: minutoDe(s.startsAt, grade.timezone),
        fimMinuto: minutoDe(s.endsAt, grade.timezone),
      }),
    );

    return {
      entendi: true as const,
      escalar: false as const,
      intencao: pedido.intencao,
      entendido: resumo(pedido),
      data: dia,
      /**
       * Três, e não a grade inteira.
       *
       * *"18:20 · 19:00 · 20:10"* — é o exemplo da SPEC, e ele tem três por uma
       * razão: uma lista de vinte horários numa conversa não é escolha, é
       * planilha. Quem quer ver tudo tem a página.
       */
      horarios: servem.slice(0, 3).map((s) => ({
        comecaEm: s.startsAt,
        profissionalId: s.professionalId,
      })),
      /** Vazio é resposta, e a tela diz o que fazer em seguida. */
      nenhumServe: servem.length === 0,
    };
  }
}

/** O que o agente entendeu, para a proposta poder ser conferida antes de gravar. */
function resumo(pedido: PedidoDoCliente) {
  return {
    servico: pedido.servicoNome,
    profissional: pedido.profissionalNome,
    emQuantosDias: pedido.emQuantosDias,
    aPartirDeMinuto: pedido.aPartirDeMinuto,
    ateMinuto: pedido.ateMinuto,
  };
}

/**
 * O dia local, somando dias **no calendário da unidade**.
 *
 * A soma é feita sobre a data já convertida, e não sobre o instante: somar
 * 86.400.000 ms antes de converter erra na virada do dia e no horário de verão,
 * que este país teve até 2019 e pode ter de novo.
 */
function diaLocal(agora: Date, timeZone: string, mais: number): string {
  const hoje = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(agora);
  return new Date(Date.parse(`${hoje}T00:00:00Z`) + mais * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * O minuto local de um instante, no fuso **da unidade**.
 *
 * Nunca o do processo: é a regra do bloco 1, e ela é a razão de a grade de uma
 * barbearia em Rio Branco não sair três horas deslocada.
 */
function minutoDe(iso: string, timeZone: string): number {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const hora = Number(partes.find((p) => p.type === 'hour')?.value ?? '0');
  const minuto = Number(partes.find((p) => p.type === 'minute')?.value ?? '0');
  return hora * 60 + minuto;
}
