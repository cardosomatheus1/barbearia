import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import {
  CONFIANCA_PARA_AGIR,
  horarioServe,
  interpretarPedido,
  oQueFalta,
  PERGUNTA_DO_AGENTE,
  responderRecepcao,
  type DadosDaCasa,
  type PedidoDoCliente,
} from '@barbearia/core';
import { registrarLacuna } from '@barbearia/crm';
import {
  getAvailabilityRange,
  getPublicProfile,
  getReschedulableAppointment,
  listCustomerAppointments,
} from '@barbearia/scheduling';
import type { AuthenticatedCustomer } from '@barbearia/identity';
import { notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Customer, CustomerGuard, TenantId } from '../auth/customer.guard.js';
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

    /**
     * Não é pedido de agendamento? Pode ser pergunta de recepção (bloco 66).
     *
     * A ordem é essa porque agendar é o que a rota existe para fazer: uma frase
     * que é as duas coisas — "quanto custa cortar amanhã?" — deve marcar, não
     * cotar. Quem chega aqui já não é um pedido.
     */
    if (!pedido) {
      const resposta = responderRecepcao(body.texto, dadosDaCasa(perfil));
      if (resposta) {
        return { entendi: true as const, escalar: false as const, resposta: resposta.texto };
      }

      /**
       * Ninguém soube responder: escala **e registra**.
       *
       * *"Essa lista de lacunas é, sozinha, um produto útil."* O registro não
       * pode derrubar a conversa: quem está do outro lado perguntou o preço do
       * corte, e a lista é para o dono. Por isso `registrarLacuna` engole a
       * própria falha — o `await` aqui espera o registro, mas nunca uma exceção.
       */
      await registrarLacuna(tenantId, body.texto);
      return { entendi: false as const, escalar: true as const };
    }

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

/**
 * A remarcação pela conversa (bloco 66, SPEC §4.17).
 *
 * > *— Não consigo ir hoje.*
 * > *— Sem problemas. Quer remarcar com João? [horários]*
 *
 * O diálogo da SPEC responde a um **cancelamento** com uma oferta de
 * remarcação, e essa inversão é o valor do bloco: *"o cancelamento vira receita
 * para outro cliente na mesma conversa"*. Quem só cancela deixa a cadeira vazia;
 * quem remarca continua sendo atendido, e o horário liberado ainda vai para a
 * fila de espera pela rota de cancelamento que já existe.
 *
 * ## Sob sessão, ao contrário da rota de marcar
 *
 * Remarcar e cancelar exigem saber **qual** agendamento, e um id de agendamento
 * numa rota pública seria o caminho para mexer no horário alheio. A guarda
 * resolve metade; a outra metade é o filtro por `customer_id` em toda leitura —
 * a RLS separa barbearias e não separa clientes dentro de uma.
 *
 * ## Ela continua sem gravar nada
 *
 * O que sai daqui é uma proposta. Gravar continua sendo `POST
 * /appointments/:id/reschedule` e `/cancel`, que é onde moram a janela mínima, o
 * teto de remarcações, o sinal que atravessa inteiro e o disparo da fila de
 * espera. Um segundo caminho de escrita seria a metade das garantias.
 */
@Controller('v1/b/:slug/agente/meu')
@UseGuards(CustomerGuard)
export class AgenteDoClienteController {
  @Post()
  async conversar(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
    @Body(new ZodValidationPipe(conversaDoClienteSchema)) body: { texto: string },
  ) {
    const perfil = await getPublicProfile(tenantId, slug);
    if (!perfil) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');

    const pedido = interpretarPedido(body.texto, {
      servicos: perfil.categories.flatMap((c) => c.services.map((s) => ({ id: s.id, nome: s.name }))),
      profissionais: perfil.professionals.map((p) => ({ id: p.id, nome: p.name })),
    });

    /**
     * Só remarcar e cancelar entram aqui.
     *
     * Marcar tem a rota pública, que não precisa de sessão, e duplicá-la sob a
     * guarda daria duas respostas possíveis para a mesma frase conforme o
     * cookie — que é como duas telas passam a discordar sobre o mesmo fato.
     */
    if (!pedido || (pedido.intencao !== 'remarcar' && pedido.intencao !== 'cancelar')) {
      return { entendi: false as const, escalar: true as const };
    }

    const agendamentos = await listCustomerAppointments({ tenantId, customerId: customer.customerId });

    /**
     * O **próximo**, e não o primeiro da lista.
     *
     * `listCustomerAppointments` ordena do mais distante para o mais próximo, e
     * pegar `[0]` ofereceria remarcar o horário do mês que vem para quem disse
     * "não consigo ir hoje". Quem pergunta está falando do compromisso mais
     * próximo — e a redução por mínimo não depende da ordem da consulta.
     */
    const proximo = agendamentos
      .filter((a) => a.canReschedule || a.canCancel)
      .reduce<(typeof agendamentos)[number] | null>(
        (menor, a) => (menor === null || a.startsAt < menor.startsAt ? a : menor),
        null,
      );

    if (!proximo) {
      /**
       * Sem horário marcado — e isso é resposta, não falha.
       *
       * Escalar aqui mandaria para o balcão alguém que só precisa saber que não
       * tem nada marcado, que é a pergunta que a tela responde sozinha.
       */
      return {
        entendi: true as const,
        escalar: false as const,
        intencao: pedido.intencao,
        semAgendamento: true as const,
      };
    }

    const atual = await getReschedulableAppointment({
      tenantId,
      customerId: customer.customerId,
      appointmentId: proximo.id,
    });

    const agendamento = {
      id: proximo.id,
      comecaEm: proximo.startsAt,
      servicos: proximo.services,
      profissionalNome: proximo.professionalName,
      podeRemarcar: proximo.canReschedule,
      podeCancelar: proximo.canCancel,
      /** Por que o botão não está lá: botão ausente sem explicação vira ligação. */
      motivo: proximo.blockedReason,
    };

    if (!atual || !proximo.canReschedule) {
      return { entendi: true as const, escalar: false as const, intencao: pedido.intencao, agendamento };
    }

    /**
     * A grade que **ignora o próprio horário**, como a tela de remarcação.
     *
     * Sem `ignoreAppointmentId` o motor conta a própria reserva como ocupação e
     * esconde justamente a faixa em que a pessoa já cabe. E os serviços vêm do
     * agendamento, nunca da frase: aceitar da conversa deixaria remarcar para um
     * serviço mais caro pelo preço do antigo.
     */
    const dia = diaLocal(new Date(), perfil.location.timezone, pedido.emQuantosDias ?? 0);
    const grade = await getAvailabilityRange({
      tenantId,
      locationId: atual.locationId,
      serviceIds: atual.serviceIds,
      professionalId: pedido.profissionalId ?? atual.professionalId,
      dateFrom: dia,
      ignoreAppointmentId: proximo.id,
    });

    const servem = (grade.days[0]?.slots ?? []).filter((s) =>
      horarioServe(pedido, {
        inicioMinuto: minutoDe(s.startsAt, grade.timezone),
        fimMinuto: minutoDe(s.endsAt, grade.timezone),
      }),
    );

    return {
      entendi: true as const,
      escalar: false as const,
      intencao: pedido.intencao,
      agendamento,
      data: dia,
      /** Três, pela mesma razão da rota de marcar: conversa não é planilha. */
      horarios: servem.slice(0, 3).map((s) => ({
        comecaEm: s.startsAt,
        profissionalId: s.professionalId,
      })),
      nenhumServe: servem.length === 0,
    };
  }
}

/**
 * O que a casa cadastrou, no formato que a recepção digital lê.
 *
 * Tudo sai do perfil **público** — o mesmo que a página mostra. Não há uma
 * segunda fonte, e por isso a recepção nunca responde algo que a página não
 * diria.
 */
function dadosDaCasa(perfil: Awaited<ReturnType<typeof getPublicProfile>>): DadosDaCasa {
  const casa = perfil!;
  return {
    servicos: casa.categories.flatMap((c) =>
      c.services.map((s) => ({ nome: s.name, precoCents: s.priceCents })),
    ),
    // Dia sem hora de abertura é dia fechado — e a recepção precisa dizer "não
    // abrimos", que é resposta, não silêncio.
    diasAbertos: casa.hours
      .filter((h) => h.opensAt !== null && h.closesAt !== null)
      .map((h) => ({ diaDaSemana: h.weekday, abre: h.opensAt!, fecha: h.closesAt! })),
    profissionais: casa.professionals.map((p) => ({ nome: p.name, diasDaSemana: p.weekdays })),
    endereco: casa.location.street,
    politicaDeCancelamento: casa.location.cancellationPolicy,
  };
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
