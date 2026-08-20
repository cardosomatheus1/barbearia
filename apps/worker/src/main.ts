import { entregarWebhook, expirarDesafiosDeOtp, varrerEntregasPendentes } from '@barbearia/identity';
import { assertRlsEnforced, disconnect } from '@barbearia/db';
import {
  atribuirObjetivos,
  atribuirReceita,
  despacharCampanha,
  disparosAEnviar,
  enviarPeloWhatsApp,
  executarResposta,
  marcarDisparoEnviado,
  conciliarWhatsAppDaUnidade,
  provedorDoWhatsApp,
  respostaParaEnviar,
  varrerAutomacoes,
  varrerRetencao,
  expirarTextoDaRecepcao,
} from '@barbearia/crm';
import {
  aplicarReguaDoClube,
  conciliarCobrancas,
  entregarNotasAutorizadas,
  expirarSaldos,
  conciliarRecebedores,
  liquidarRepasses,
  montarAvisoDoClube,
} from '@barbearia/finance';
import {
  cancelAppointment,
  confirmAppointment,
  expirarEsperas,
  oferecerProximaVaga,
  primaryLocation,
  vencerOfertas as vencerOfertasDaEspera,
} from '@barbearia/scheduling';
import {
  FakeCobrancaDoClubeProvider,
  FakeSplitProvider,
  MINUTOS_DE_JANELA_EXCLUSIVA,
  diaNaUnidade,
  type CobrancaDoClubeProvider,
  type MotivoDoAvisoDoClube,
  type SplitProvider,
  type TipoDeNotificacao,
  VARIAVEIS_DO_AVISO,
} from '@barbearia/core';
import {
  avisarDaOperacao,
  CODIGO_DA_RETENCAO,
  ConsoleOperacaoProvider,
  atribuirDaBarbearia,
  atualizarVitrineDaCasa,
  emitirComissaoDoMarketplace,
  varrerVitrine,
} from '@barbearia/platform';
import {
  ConsoleNotificationProvider,
  RELOGIO_REAL,
  rodarWorker,
  type MensagemDeAgendamento,
  type MensagemDeAutomacao,
  type MensagemDeCampanha,
  type MensagemDeFila,
  type MensagemDeNota,
  type MensagemDeRecado,
  type MensagemDeVaga,
  type MensagemDoClube,
  type NotificationProvider,
  type ResultadoDaRodada,
} from '@barbearia/jobs';

import { emissorFiscal, enviarNota } from '@barbearia/finance';

/**
 * O emissor sai de `FISCAL_MODO`, e pode ser **nenhum**.
 *
 * Antes era `new FakeFiscalProvider()` fixo aqui e outro fixo no controller —
 * dois lugares para ligar o emissor de verdade, e o que acontece é ligar num e
 * esquecer no outro. É a cicatriz que `modoDoAdquirente` já tinha fechado do
 * lado do dinheiro, e que o lado fiscal não copiou.
 *
 * Com `nenhum`, `pedirNota` recusa antes de criar a linha, então a fila não
 * recebe tarefa — e o `null` aqui é o que faz o handler falhar alto se alguma
 * tarefa antiga sobreviver a uma troca de configuração.
 */
const EMISSOR_FISCAL = emissorFiscal();

/**
 * Falha alto, e é o certo aqui.
 *
 * A tarefa só existe se `pedirNota` a criou, e ela recusa sem emissor. Chegar
 * aqui com `null` significa configuração trocada com fila cheia — e a tarefa
 * ficar retentando com erro visível é melhor que ser descartada em silêncio,
 * porque a nota do cliente continua devendo.
 */
function exigirEmissorFiscal() {
  if (!EMISSOR_FISCAL) {
    throw new Error('FISCAL_MODO=nenhum, mas há tarefa de nota na fila');
  }
  return EMISSOR_FISCAL;
}
import {
  CobrancaManualProvider,
  ConsoleGestorProvider,
  PspCobrancaProvider,
  adquirenteDaComanda,
  adquirenteDaPlataforma,
  aplicarRegua,
  conciliarPendentes,
  executarAvisoDeCobranca,
  recursoLigado,
  type AssuntoDoAviso,
  type CobrancaProvider,
  type PspProvider,
} from '@barbearia/platform';

/**
 * O segundo processo do produto.
 *
 * Até o bloco 20 existia um só: a API, que só faz coisa enquanto alguém espera a
 * resposta. Lembrete de 24 horas não cabe nesse modelo — ninguém está esperando
 * às 9h da manhã de ontem.
 *
 * Ele é deliberadamente burro. Toda regra está em `packages/core`, todo acesso a
 * dado passa por `withTenant` dentro do handler, e este arquivo só liga o
 * provedor ao laço e cuida de terminar direito.
 *
 * **Sobe junto com a API, não no lugar dela.** São dois processos do mesmo
 * código, e o `SKIP LOCKED` já permite quantas cópias forem necessárias sem
 * duas pegarem a mesma tarefa.
 */

const INTERVALO_MS = Number(process.env['WORKER_INTERVALO_MS'] ?? 5_000);

/**
 * Onde a página do cliente mora, para montar o link do convite de vaga.
 *
 * Variável de ambiente porque o endereço muda por instalação, e um valor fixo
 * aqui mandaria o cliente de produção para `localhost`. O padrão serve ao
 * desenvolvimento, que é onde o provedor de console roda.
 */
const WEB_URL = process.env['WEB_URL'] ?? 'http://localhost:3001';

/**
 * O adquirente, quando há um configurado.
 *
 * Quem escolhe é `adquirenteDaPlataforma` (bloco 34), e é de propósito que a
 * escolha não more aqui: a API também cobra — estorno de crédito hoje, comanda
 * a partir do bloco 35 — e dois processos decidindo cada um por si significa
 * ligar a Stripe num e esquecer no outro, com a régua debitando de verdade
 * enquanto o estorno devolve dinheiro de mentira.
 *
 * Sem `PSP_MODO`, a plataforma segue no modo do bloco 28: nada é debitado
 * sozinho e quem quita fatura é o Super Admin registrando o pagamento que viu
 * no extrato.
 *
 * **Não há credencial neste arquivo.** As chaves da Stripe chegam por variável
 * de ambiente, como todo o resto.
 */
function ligarAdquirente(): { psp: PspProvider | null; cobranca: CobrancaProvider } {
  const psp = adquirenteDaPlataforma();
  if (psp === null) return { psp: null, cobranca: new CobrancaManualProvider() };
  return { psp, cobranca: new PspCobrancaProvider(psp) };
}

const { psp, cobranca } = ligarAdquirente();

/**
 * O provedor de mensagem do processo, **um só**.
 *
 * Instanciar `ConsoleNotificationProvider` dentro de um caminho específico faz
 * daquele caminho o único que não troca junto: no dia em que o WhatsApp de
 * verdade for ligado na linha de baixo, o convite de vaga continuaria sendo
 * impresso no log — e ele carrega o token em claro, que é credencial. Achado da
 * revisão de segurança do bloco 39.
 */
/**
 * O canal da casa por cima do canal de reserva (bloco 82).
 *
 * ## Por que o roteamento é aqui, e não em cada chamador
 *
 * Antes deste bloco, `enviarPeloWhatsApp` não tinha chamador nenhum fora do
 * teste: a barbearia cadastrava o número, via "Ativo" na tela, aprovava o
 * template — e toda mensagem continuava saindo pelo log. A primeira versão do
 * conserto ligou os dois caminhos que já resolviam a unidade (campanha e
 * automação) e deixou o lembrete de 24h de fora, o que é o defeito da §6
 * pergunta 6: duas telas afirmando coisas diferentes sobre o mesmo fato.
 *
 * Com o roteamento **no provedor**, existe um lugar só que decide o canal — e
 * é a mesma razão de haver um provedor só no processo: um caminho que decide
 * sozinho é o caminho que não troca junto quando o canal muda.
 *
 * ## Reserva não é falha
 *
 * `enviarPeloWhatsApp` devolve `null` quando o canal não está disponível —
 * `WHATSAPP_MODO=nenhum`, cadastro em branco, número não verificado, template
 * não aprovado — e aí a mensagem cai para o console, que é o que a SPEC §4.12
 * pede em letras. Transformar indisponibilidade em exceção faria a tarefa da
 * fila morrer em vez de usar o outro caminho.
 *
 * ## As variáveis posicionais saem de `VARIAVEIS_DO_AVISO`
 *
 * A Meta preenche por **posição**, e a ordem daqui precisa ser a mesma que a
 * tela de cadastro do texto mostra. Escritas nos dois lugares, elas divergiram:
 * a tela prometia hora e profissional, e aqui saíam nome e **nome da
 * barbearia** — quem escrevesse "seu corte é amanhã às {{2}}" mandava ao
 * cliente "seu corte é amanhã às Barbearia Matheus".
 *
 * E o pior era o dado descartado: `quandoTexto` e `profissional` já chegavam
 * dentro da mensagem de agendamento e não eram lidos.
 */
class CanalDaCasa implements NotificationProvider {
  constructor(private readonly reserva: NotificationProvider) {}

  private async pelaCasa(params: {
    readonly tenantId: string;
    readonly locationId: string;
    readonly tipo: TipoDeNotificacao;
    readonly telefone: string;
    readonly clienteNome: string;
    readonly barbearia: string;
    /** Só as mensagens de horário marcado têm os dois. */
    readonly quandoTexto?: string | undefined;
    readonly profissional?: string | undefined;
    readonly appointmentId?: string | null;
    /** Qual texto mandar, quando quem chamou escolheu (bloco 94). */
    readonly templateId?: string | null | undefined;
  }): Promise<string | null> {
    const zap = await provedorDoWhatsApp(params.tenantId, params.locationId);
    if (!zap) return null;

    /**
     * A ordem é a de `VARIAVEIS_DO_AVISO`, e a correspondência é por posição.
     *
     * Quando o tipo pede hora e profissional e a mensagem não os traz — não
     * deveria acontecer, e o tipo não consegue provar —, o que falta vira
     * string vazia em vez de sumir: uma lista mais curta faz a Meta recusar o
     * envio inteiro, e a pessoa recebe nada em vez de uma frase incompleta.
     */
    const valores: Record<string, string> = {
      'o nome do cliente': params.clienteNome,
      'o nome da barbearia': params.barbearia,
      'a hora do agendamento': params.quandoTexto ?? '',
      'o nome do profissional': params.profissional ?? '',
    };

    const enviada = await enviarPeloWhatsApp({
      tenantId: params.tenantId,
      locationId: params.locationId,
      tipo: params.tipo,
      telefone: params.telefone,
      variaveis: VARIAVEIS_DO_AVISO[params.tipo].map((qual) => valores[qual] ?? ''),
      templateId: params.templateId ?? null,
      // `notifications` já guarda quem recebeu; `whatsapp_messages` guarda o
      // vínculo com o template, e é por ele que a entrega é conciliada.
      customerId: null,
      appointmentId: params.appointmentId ?? null,
      provider: zap,
    });
    return enviada?.wamid ?? null;
  }

  async enviarDeAgendamento(mensagem: MensagemDeAgendamento): Promise<void> {
    const foi = await this.pelaCasa({
      tenantId: mensagem.tenantId,
      locationId: mensagem.locationId,
      tipo: mensagem.tipo,
      telefone: mensagem.phoneE164,
      clienteNome: mensagem.clienteNome,
      barbearia: mensagem.barbearia,
      // Os dois já vinham na mensagem e eram descartados aqui.
      quandoTexto: mensagem.quandoTexto,
      profissional: mensagem.profissional,
    });
    if (!foi) await this.reserva.enviarDeAgendamento(mensagem);
  }

  async enviarDeFila(mensagem: MensagemDeFila): Promise<void> {
    const foi = await this.pelaCasa({
      tenantId: mensagem.tenantId,
      locationId: mensagem.locationId,
      tipo: 'sua_vez',
      telefone: mensagem.phoneE164,
      clienteNome: mensagem.clienteNome,
      barbearia: mensagem.barbearia,
    });
    if (!foi) await this.reserva.enviarDeFila(mensagem);
  }

  async enviarDeAutomacao(mensagem: MensagemDeAutomacao): Promise<void> {
    const foi = await this.pelaCasa({
      tenantId: mensagem.tenantId,
      locationId: mensagem.locationId,
      tipo: mensagem.tipo,
      telefone: mensagem.phoneE164,
      clienteNome: mensagem.clienteNome,
      barbearia: mensagem.barbearia,
      templateId: mensagem.templateId,
    });
    if (!foi) await this.reserva.enviarDeAutomacao(mensagem);
  }

  async enviarDeCampanha(mensagem: MensagemDeCampanha): Promise<string | null> {
    const wamid = await this.pelaCasa({
      tenantId: mensagem.tenantId,
      locationId: mensagem.locationId,
      tipo: mensagem.tipo,
      telefone: mensagem.phoneE164,
      clienteNome: mensagem.clienteNome,
      barbearia: mensagem.barbearia,
      // O texto que esta campanha escolheu. Sem ele o motor pegava o primeiro
      // aprovado do tipo, e a prévia da tela mentia sobre o que ia sair.
      templateId: mensagem.templateId,
    });
    if (wamid) return wamid;
    return this.reserva.enviarDeCampanha(mensagem);
  }

  /**
   * As quatro que **não** passam pelo canal da casa, e o motivo é um só.
   *
   * A Meta exige um template aprovado por tipo, e `notification_kind` não
   * nomeia convite de vaga, recado, aviso do clube nem nota fiscal. Sem tipo
   * não há template a escolher — então elas não têm por onde sair, e delegar é
   * a resposta certa, não um esquecimento.
   */
  enviarDeVaga(mensagem: MensagemDeVaga): Promise<void> {
    return this.reserva.enviarDeVaga(mensagem);
  }
  enviarDeRecado(mensagem: MensagemDeRecado): Promise<void> {
    return this.reserva.enviarDeRecado(mensagem);
  }
  enviarDoClube(mensagem: MensagemDoClube): Promise<void> {
    return this.reserva.enviarDoClube(mensagem);
  }
  enviarDeNota(mensagem: MensagemDeNota): Promise<void> {
    return this.reserva.enviarDeNota(mensagem);
  }
}

const provider: NotificationProvider = new CanalDaCasa(new ConsoleNotificationProvider());

/**
 * O adquirente do clube — hoje, o de mentira.
 *
 * Ele **recusa** toda cobrança, e isso é o comportamento correto do produto como
 * ele está: não existe ainda por onde a barbearia tokenizar o cartão do
 * assinante (lacuna declarada, bloco 51). Sem token salvo a régua nem chega a
 * chamá-lo — ela pula a cobrança sem gastar degrau —, e o caminho que de fato
 * quita a mensalidade é o balcão registrando o Pix que viu no extrato.
 *
 * Está aqui, e não dentro de `finance`, pelo mesmo motivo de todos os outros
 * provedores: quem escolhe implementação é quem monta o processo. No dia em que
 * a tokenização entrar, troca-se esta linha e nada mais.
 */
let clubeProvider: CobrancaDoClubeProvider | null = null;
const cobrancaDoClube = (): CobrancaDoClubeProvider =>
  (clubeProvider ??= new FakeCobrancaDoClubeProvider());

/**
 * O adquirente do split — hoje, o de mentira (bloco 50).
 *
 * Ele deixa o cadastro **pendente** e recusa o repasse, e as duas escolhas são o
 * estado real do produto sem conta contratada. Sem cadastro aprovado a parte do
 * barbeiro fica retida, o dinheiro cai inteiro na casa e a comissão sai no
 * fechamento — que é como toda barbearia do país paga o barbeiro hoje, e é o
 * caminho que a SPEC §3.5 manda não bloquear.
 */
let splitProvider: SplitProvider | null = null;
const adquirenteDoSplit = (): SplitProvider => (splitProvider ??= new FakeSplitProvider());

async function main(): Promise<void> {
  // Mesma guarda da API: se a conexão ignora RLS, o isolamento entre barbearias
  // não existe. Aqui o risco é maior, porque o worker atravessa tenants por
  // desenho — uma tarefa de cada barbearia, uma de cada vez.
  await assertRlsEnforced();

  let parando = false;
  const parar = (sinal: string): void => {
    if (parando) return;
    parando = true;
    // Sem `process.exit`: o laço confere `parar()` entre tarefas e sai depois
    // de terminar a que está em curso. Matar no meio deixaria `running`
    // pendurado até a varredura de órfãs — que existe, mas é a rede, não o
    // plano.
    console.log(`[worker] ${sinal} recebido; terminando a tarefa em curso`);
  };

  process.on('SIGTERM', () => parar('SIGTERM'));
  process.on('SIGINT', () => parar('SIGINT'));

  console.log(`[worker] ouvindo a fila a cada ${INTERVALO_MS}ms`);

  await rodarWorker(
    {
      provider,
      relogio: RELOGIO_REAL,
      // É aqui que a plataforma se liga ao worker, e só aqui: `packages/jobs`
      // não conhece a camada de cima, do mesmo jeito que não conhece o provedor
      // de mensagem. Quem monta o processo é quem liga as duas pontas.
      recursoLigado,
      /**
       * A cobrança da assinatura (bloco 28), ligada aqui pelo mesmo motivo.
       *
       * O provedor sai de `ligarAdquirente`. Sem `PSP_MODO` ele é o manual, e
       * o que quita uma fatura é alguém registrando no painel o pagamento que
       * viu no extrato. A régua roda inteira em cima de qualquer um dos dois —
       * emite, avisa, marca vencida e suspende quem passou de 21 dias.
       */
      avisarDeCobranca: (aviso) =>
        executarAvisoDeCobranca({
          tenantId: aviso.tenantId,
          faturaId: aviso.faturaId,
          assunto: aviso.assunto as AssuntoDoAviso,
          provider: new ConsoleGestorProvider(),
          agora: aviso.agora,
        }),
      /**
       * O emissor de nota (bloco 53), ligado aqui pelo mesmo motivo.
       *
       * **Um só, criado onde o processo é montado** — é a lição do bloco 39 com
       * o provedor de mensagem: instanciar um dentro de um caminho faz daquele
       * caminho o único que não troca junto quando o emissor de verdade entrar.
       *
       * Enquanto não há contrato com emissor, é o de mentira, e ele responde
       * `processando` por padrão: a cadeia de conciliação — a tarefa se
       * reprogramando, a tela saindo de "na prefeitura" — é exercida pelo
       * caminho real, e não pulada por um fake otimista.
       */
      processarNota: (tenantId, invoiceId) =>
        enviarNota({ tenantId, invoiceId, provider: exigirEmissorFiscal() }),
      /**
       * A nota autorizada chegando ao cliente (bloco 54), ligada aqui pelo mesmo
       * motivo da retenção: ela mora em `packages/finance`, decide com
       * `packages/core` e manda pelo **mesmo** `provider` de todo o resto —
       * instanciar um aqui faria deste o único caminho que não troca junto
       * quando o WhatsApp oficial entrar.
       */
      /**
       * O botão da mensagem virando ação (bloco 55), ligado aqui pelo mesmo
       * motivo da retenção: a decisão mora em `packages/crm`, e quem mexe na
       * agenda é `packages/scheduling` — dois pacotes que `jobs` não conhece.
       *
       * `cancelAppointment` recebe `customerId` **sempre**: a RLS separa
       * barbearias e não separa clientes dentro de uma, e o toque veio de fora.
       * Sem ele, quem descobrisse um id cancelaria o horário de qualquer outro
       * cliente da mesma casa.
       */
      responderWhatsApp: async (tenantId, inboundId, agora) => {
        await executarResposta({
          tenantId,
          inboundId,
          agora,
          cancelar: async ({ appointmentId, customerId }) => {
            await cancelAppointment({
              tenantId,
              appointmentId,
              by: 'customer',
              customerId,
              reason: 'cancelado pelo WhatsApp',
              now: agora,
            });
          },
          confirmar: async ({ appointmentId, customerId }) => {
            await confirmAppointment({ tenantId, appointmentId, customerId });
          },
        });
      },

      /**
       * Uma volta do motor de automação (bloco 56).
       *
       * Marca os disparos e manda o que já venceu, na mesma volta. O carimbo vem
       * **antes** da mensagem — precedente do bloco 54 —, e a mensagem sai pelo
       * mesmo `provider` de todo o resto: instanciar um aqui faria deste o único
       * caminho que não troca junto quando o WhatsApp oficial entrar.
       */
      /**
       * O que a Meta ainda não respondeu desta barbearia (bloco 90).
       *
       * `primaryLocation` e não todas as unidades, como `rodarAutomacoes`: o
       * cadastro de WhatsApp é por unidade, e cobrir a rede inteira aqui seria
       * escopo que nenhuma barbearia deste produto exerce hoje — está declarado
       * como lacuna, com bloco, em vez de virar um laço que ninguém exercita.
       */
      conciliarWhatsApp: async (tenantId, agora) => {
        const local = await primaryLocation(tenantId);
        if (!local) return { promovido: false, templates: 0 };
        return conciliarWhatsAppDaUnidade(tenantId, local.id, agora);
      },
      rodarAutomacoes: async (tenantId, agora) => {
        const local = await primaryLocation(tenantId);
        if (!local) return;

        const varrida = await varrerAutomacoes({ tenantId, agora, timeZone: local.timezone });
        const fila = await disparosAEnviar(tenantId, agora);

        let enviados = 0;
        for (const disparo of fila) {
          const nossa = await marcarDisparoEnviado({ tenantId, disparoId: disparo.id });
          if (!nossa) continue;
          // Quem escolhe o canal é o provedor. Decidir aqui faria deste o único
          // caminho que não troca junto no dia em que o canal mudar.
          await provider.enviarDeAutomacao({
            tenantId,
            locationId: local.id,
            phoneE164: disparo.telefone,
            clienteNome: disparo.clienteNome,
            barbearia: disparo.barbearia,
            tipo: disparo.tipo,
            // O texto que esta automação escolheu. Sem ele, as onze automações
            // possíveis saíam todas com a mesma frase.
            templateId: disparo.templateId,
          });
          enviados += 1;
        }

        await atribuirObjetivos({ tenantId, agora });

        /**
         * A receita das campanhas é atribuída **aqui**, de hora em hora.
         *
         * Ela morava só dentro de `campanha.enviar` — e naquele instante nenhuma
         * venda pode satisfazer `closed_at > sent_at`, porque a mensagem acabou
         * de sair. `campanha.enviar` é tarefa de uma vez só e não se reprograma,
         * então "a única coluna que importa numa campanha" ficava em R$ 0,00 até
         * alguém despachar a **próxima** campanha. Para quem roda uma por mês, o
         * número que decide se marketing vale a pena era zero por um mês; para
         * quem rodou uma só, zero para sempre.
         *
         * A varredura de automação é o lugar certo por já ser o que é: roda de
         * hora em hora, por barbearia, com o tenant no contexto. É o mesmo
         * desenho de `atribuirObjetivos` logo acima, que sempre esteve certo — e
         * é a diferença entre as duas que fazia uma funcionar e a outra não.
         *
         * `atribuirReceita` varre os alvos enviados de **todas** as campanhas da
         * casa, então uma volta por hora dá conta de qualquer número delas.
         */
        await atribuirReceita({ tenantId, agora });

        /**
         * E o vencimento do saldo de fidelidade, que não tinha chamador nenhum.
         *
         * O saldo já **some da leitura** no instante em que vence — quem lê usa
         * `saldoDisponivel`, que olha o relógio. O que faltava era o extrato: sem
         * a linha de `expiracao`, a soma das linhas não bate com o saldo
         * mostrado, e a primeira pessoa a conferir a conta na mão encontra uma
         * diferença que ninguém sabe explicar. Numa tela cujo assunto é
         * *"por que caiu?"*, isso é o pior desfecho possível.
         *
         * De hora em hora é seguro porque a conta é idempotente:
         * `quantidadeAExpirar` desconta o que já foi expirado, então a segunda
         * volta encontra zero e não escreve nada.
         *
         * Achada pela guarda que este bloco criou, não pela revisão.
         */
        await expirarSaldos(tenantId, agora);

        if (varrida.marcados > 0 || enviados > 0) {
          // Só contagem: quem recebeu é dado de cliente, e log não é lugar dele.
          console.log('[automacao]', { tenantId, marcados: varrida.marcados, enviados });
        }
      },

      /**
       * O despacho de uma campanha (bloco 82).
       *
       * A tarefa nasce dentro da transação que põe a campanha em `enviando`, e
       * não se reprograma: a fila já retenta com espera crescente e
       * `soltarOrfas` devolve o que ficou preso. Uma varredura por cima seria a
       * segunda noção de "quando tentar de novo" — ela pegaria a campanha cuja
       * tarefa está em espera e despacharia antes da hora, derrubando o
       * intervalo que a espera existe para dar.
       *
       * O que segura o envio duplo é o estado do alvo (`sent_at IS NULL`), lá
       * dentro: uma retentativa continua de onde parou em vez de recomeçar.
       */
      enviarCampanha: async (tenantId, campanhaId, agora) => {
        const local = await primaryLocation(tenantId);
        if (!local) return;

        const resultado = await despacharCampanha({
          tenantId,
          campanhaId,
          agora,
          timeZone: local.timezone,
          enviar: (alvo) =>
            provider.enviarDeCampanha({
              tenantId,
              locationId: local.id,
              phoneE164: alvo.telefone,
              clienteNome: alvo.clienteNome,
              barbearia: alvo.barbearia,
              tipo: alvo.tipo,
              templateId: alvo.templateId,
            }),
        });

        /**
         * A receita atribuída, na mesma volta.
         *
         * Ela varre os alvos já enviados de **todas** as campanhas da casa, e
         * não só desta: uma venda que fecha hoje pode ser de um envio de
         * semana passada. Ficar pendurada no despacho é o que a tira de órfã —
         * antes deste bloco ela não tinha chamador nenhum, e a única coluna que
         * importa numa campanha ficava vazia para sempre.
         */
        const atribuidos = await atribuirReceita({ tenantId, agora });

        // Só contagem: quem recebeu é dado de cliente, e log não é lugar dele.
        console.log('[campanha]', {
          tenantId,
          enviados: resultado.enviados,
          pulados: resultado.pulados,
          atribuidos,
        });
      },

      entregarNotas: async (tenantId, agora) => {
        const resultado = await entregarNotasAutorizadas({
          tenantId,
          agora,
          enviar: (mensagem) => provider.enviarDeNota(mensagem),
        });
        if (resultado.enviadas > 0) {
          // Só a contagem: o link é documento público, mas o que ele identifica
          // é uma pessoa e o que ela comprou.
          console.log('[fiscal] notas entregues', { tenantId, enviadas: resultado.enviadas });
        }
      },
      /**
       * A retenção de dado pessoal (bloco 32), ligada aqui pelo mesmo motivo
       * da cobrança: ela mora em `packages/crm`, e `jobs` não conhece a camada
       * de cima.
       */
      /**
       * A vitrine do marketplace (bloco 70), ligada aqui pelo mesmo motivo da
       * retenção: ela mora em `packages/platform`, e `jobs` não conhece a camada
       * de cima.
       */
      atualizarVitrine: async (tenantId, agora) => atualizarVitrineDaCasa(tenantId, agora),
      atribuirClientesNovos: async (tenantId, agora) => atribuirDaBarbearia(tenantId, agora),
      cobrarComissaoDoMarketplace: async (tenantId, agora) => {
        await emitirComissaoDoMarketplace({ tenantId, agora });
      },
      entregarWebhook: async (entregaId, agora) => entregarWebhook(entregaId, agora),
      varrerWebhooks: async (agora) => varrerEntregasPendentes(agora),

      /**
       * A vitrine do marketplace, refeita de hora em hora (bloco 110).
       *
       * `atualizarVitrineDaCasa` é chamada nos dois pontos de evento — publicar
       * a página e contestar uma avaliação —, então o card não fica velho pelos
       * caminhos óbvios. O que faltava era a rede: preço e nota mudam por
       * caminhos que não conhecem a vitrine, e chamar a atualização de dentro de
       * cada um espalharia a vitrine por cinco pacotes, com o primeiro caminho
       * novo esquecendo dela.
       *
       * Ela existia, exportada e testada, **sem chamador nenhum** do bloco 70 ao
       * 110 — enquanto o cabeçalho da migração 0067 afirmava o contrário. Quem
       * achou foi a guarda do bloco 108.
       */
      varrerVitrine: async (agora) => varrerVitrine(agora),
      varrerRetencao: async (tenantId, agora) => {
        /**
         * O texto cru das perguntas anônimas vence junto (bloco 66).
         *
         * Mora nesta volta e não numa tarefa própria porque é a mesma pergunta —
         * "o que a barbearia já não pode guardar?" —, e uma segunda tarefa
         * diária seria mais um lugar para alguém esquecer de ligar no worker
         * seguinte. Antes da varredura de cadastro, porque não depende dela e
         * uma exceção lá não pode deixar o texto para trás.
         */
        /**
         * O desafio de OTP vence junto, e pela mesma pergunta.
         *
         * Ele guarda telefone em claro e o nome digitado antes de confirmar, de
         * quem muitas vezes **nunca virou cliente** — e por isso nem a
         * anonimização nem a retenção de cinco anos o alcançam. É a linha que
         * faltava para "cópia de dado pessoal fora de `customers` vive com prazo
         * escrito" valer também aqui.
         */
        const desafios = await expirarDesafiosDeOtp({ tenantId, agora });
        if (desafios > 0) {
          console.log('[lgpd] desafios de OTP expirados', { tenantId, linhas: desafios });
        }

        const expirados = await expirarTextoDaRecepcao({ tenantId, agora });
        if (expirados > 0) {
          // Só a contagem: o texto que está sendo apagado por ser possivelmente
          // pessoal não pode sair no log ao ser apagado.
          console.log('[lgpd] texto da recepção expirado', { tenantId, linhas: expirados });
        }

        const resultado = await varrerRetencao({ tenantId, agora });
        if (resultado.avisados.length > 0 || resultado.anonimizados > 0) {
          console.log('[lgpd] retenção', {
            tenantId,
            // Só a contagem: nome de cliente prestes a ser anonimizado no log
            // seria dado pessoal sobrevivendo à própria anonimização.
            avisados: resultado.avisados.length,
            anonimizados: resultado.anonimizados,
          });
        }
        /**
         * O aviso de retenção sai pelo mesmo canal do alerta (bloco 33).
         *
         * Era lacuna declarada: a varredura carimbava quem estava para sair e a
         * tela listava, mas quem não abrisse a tela em trinta dias perdia
         * cadastro sem nunca ter sido avisado ativamente. É obrigação legal, não
         * cortesia — por isso `enviar_retencao` nasce ligado.
         *
         * Uma mensagem por dia com a **contagem**, e não uma por cliente: o
         * nome de quem está para ser anonimizado não pode viajar por mensagem
         * nem ficar em log. A lista com nome está na tela, atrás de login.
         */
        if (resultado.avisados.length > 0) {
          await avisarDaOperacao({
            tenantId,
            agora,
            provider: new ConsoleOperacaoProvider(),
            alertas: [
              {
                regra: CODIGO_DA_RETENCAO,
                severidade: 'critico',
                frase:
                  `${resultado.avisados.length} cadastro(s) sem atendimento há cinco anos ` +
                  'serão apagados em 30 dias. Veja quem em Privacidade.',
                valor: resultado.avisados.length,
                referencia: 0,
              },
            ],
          });
        }

        return { avisados: resultado.avisados.length, anonimizados: resultado.anonimizados };
      },
      /**
       * A expiração da lista de espera (bloco 38), ligada aqui pelo mesmo
       * motivo da retenção: ela mora em `packages/scheduling`, e `jobs` não
       * conhece a camada de cima.
       */
      /**
       * A oferta de vaga da lista de espera (bloco 39), ligada aqui.
       *
       * Duas pontas que `jobs` não conhece: `scheduling`, que decide a quem
       * oferecer, e o provedor de mensagem, que entrega. É o mesmo desenho da
       * retenção e da régua de cobrança.
       *
       * O link carrega o token em claro — é a única vez que ele existe fora de
       * quem o gerou. `notifications` guarda que a mensagem saiu, nunca o
       * conteúdo dela.
       */
      oferecerVagaDaEspera: async (tenantId, vaga, agora) => {
        const oferta = await oferecerProximaVaga({
          tenantId,
          locationId: vaga.locationId,
          professionalId: vaga.professionalId,
          inicio: vaga.inicio,
          fim: vaga.fim,
          agora,
        });
        if (!oferta || !oferta.telefone) return false;

        await provider.enviarDeVaga({
          phoneE164: oferta.telefone,
          clienteNome: oferta.customerNome,
          barbearia: oferta.barbearia,
          profissional: oferta.profissionalNome,
          quandoTexto: `${oferta.dia} às ${oferta.hora}`,
          minutosParaResponder: MINUTOS_DE_JANELA_EXCLUSIVA,
          link: `${WEB_URL}/vaga/${oferta.token}`,
        });
        return true;
      },

      /**
       * A janela venceu: passa ao próximo (bloco 39).
       *
       * Reenfileira a oferta em vez de oferecer aqui, e é de propósito: assim a
       * segunda oferta passa pela mesma janela de silêncio e pelo mesmo
       * interruptor de avisos que a primeira. Oferecer direto duplicaria as duas
       * regras neste arquivo.
       */
      vencerOfertasDaEspera: async (tenantId, agora) => {
        const vagas = await vencerOfertasDaEspera(tenantId, agora);
        for (const vaga of vagas) {
          await oferecerProximaVaga({
            tenantId,
            locationId: vaga.locationId,
            professionalId: vaga.professionalId,
            inicio: vaga.inicio,
            fim: vaga.fim,
            agora,
            exceto: vaga.exceto,
          }).then(async (oferta) => {
            if (!oferta || !oferta.telefone) return;
            await provider.enviarDeVaga({
              phoneE164: oferta.telefone,
              clienteNome: oferta.customerNome,
              barbearia: oferta.barbearia,
              profissional: oferta.profissionalNome,
              quandoTexto: `${oferta.dia} às ${oferta.hora}`,
              minutosParaResponder: MINUTOS_DE_JANELA_EXCLUSIVA,
              link: `${WEB_URL}/vaga/${oferta.token}`,
            });
          });
        }
        return vagas.length;
      },

      /**
       * A resposta ao recado do cliente (bloco 40), ligada aqui.
       *
       * Duas pontas que `jobs` não conhece: `crm`, que sabe o que foi
       * respondido a quem, e o provedor de mensagem, que entrega. Mesmo desenho
       * da oferta de vaga — e o **mesmo** provedor, não uma instância nova, para
       * que ligar o WhatsApp de verdade ligue também este caminho.
       */
      responderRecadoDoCliente: async (tenantId, recadoId) => {
        const resposta = await respostaParaEnviar(tenantId, recadoId);
        if (!resposta) return false;

        await provider.enviarDeRecado({
          phoneE164: resposta.telefone,
          clienteNome: resposta.clienteNome,
          barbearia: resposta.barbearia,
          resposta: resposta.resposta,
        });
        return true;
      },

      /**
       * A régua de cobrança do clube (bloco 47).
       *
       * Duas pontas que `jobs` não conhece: `finance`, que sabe o que é uma
       * fatura, e o adquirente. Mesmo desenho da conciliação de cobranças — e o
       * provedor entra por uma função só, para que ligar a Stripe de verdade
       * ligue este caminho junto.
       */
      /**
       * A liquidação dos repasses (bloco 50).
       *
       * A conciliação do cadastro vem **antes**, e a ordem é decisão: descobrir
       * que o barbeiro foi aprovado depois de reter a parte dele faria o dinheiro
       * dele passar mais um dia pela casa por um webhook que se perdeu.
       */
      liquidarRepasses: async (tenantId, agora) => {
        const provider = adquirenteDoSplit();
        const cadastros = await conciliarRecebedores({ tenantId, provider, agora });
        if (cadastros.aprovados > 0) {
          console.log('[split] cadastros aprovados', { tenantId, ...cadastros });
        }

        const resultado = await liquidarRepasses({ tenantId, provider, agora });
        const mexeu = Object.values(resultado).some((n) => n > 0);
        if (mexeu) console.log('[split] liquidação do dia', { tenantId, ...resultado });
        return { repassados: resultado.repassados, retidos: resultado.retidos };
      },

      rodarCobrancaDoClube: async (tenantId, agora) => {
        const resultado = await aplicarReguaDoClube({
          tenantId,
          provider: cobrancaDoClube(),
          agora,
        });
        const mexeu = Object.values(resultado).some((n) => n > 0);
        if (mexeu) console.log('[clube] régua do dia', { tenantId, ...resultado });
        return { cobradas: resultado.cobradas, suspensas: resultado.suspensas };
      },

      /**
       * O aviso do clube, pelo **mesmo** provedor de tudo o mais.
       *
       * Não uma instância nova: instanciar o de console dentro de um caminho faz
       * daquele caminho o único que não troca junto quando o WhatsApp de verdade
       * entrar — e este carrega a frase que diz ao cliente que o plano dele
       * parou.
       */
      avisarDoClube: async (tenantId, assinaturaId, motivo, agora) => {
        const aviso = await montarAvisoDoClube({
          tenantId,
          assinaturaId,
          motivo: motivo as MotivoDoAvisoDoClube,
          agora,
        });
        if (!aviso) return false;

        await provider.enviarDoClube({
          phoneE164: aviso.telefone,
          barbearia: aviso.barbearia,
          motivo,
          texto: aviso.texto,
        });
        return true;
      },

      expirarEsperas: async (tenantId, agora) => {
        const quantas = await expirarEsperas(tenantId, agora);
        // Só a contagem: quem estava esperando é dado de cliente, e log não é
        // lugar dele.
        if (quantas > 0) console.log('[espera] expiradas', { tenantId, quantas });
        return quantas;
      },
      /**
       * O alerta operacional (bloco 33), ligado aqui pelo mesmo motivo dos
       * outros dois: quem produz a lista é `jobs`, quem conhece o dono e o
       * canal é a plataforma, e nenhum dos dois deve conhecer o outro.
       */
      avisarDaOperacao: async (tenantId, alertas, agora) => {
        const resultado = await avisarDaOperacao({
          tenantId,
          alertas,
          agora,
          provider: new ConsoleOperacaoProvider(),
        });
        if (resultado.enviados > 0) {
          console.log('[operacao] alerta', { tenantId, enviados: resultado.enviados });
        }
      },
      /**
       * A conferência das cobranças online (bloco 35), ligada aqui pelo mesmo
       * motivo de todas as outras: ela precisa do adquirente e do **fuso da
       * unidade**, e `jobs` não conhece nenhum dos dois.
       *
       * O fuso importa mais aqui do que no balcão: a comissão é datada pelo dia
       * da barbearia, e esta tarefa roda meia hora depois da emissão — às 22h de
       * Salvador o UTC já virou, e ela cairia no mês seguinte do acerto do
       * barbeiro (defeito D2, o mesmo que erra a grade).
       */
      conciliarCobrancas: async (tenantId, agora) => {
        // O fuso não sai mais daqui: cada cobrança carrega a própria loja, e o
        // domínio resolve o dia com o fuso dela. Pela unidade mais antiga, a
        // venda de uma filial em outro fuso era datada pelo dia da matriz.
        const resultado = await conciliarCobrancas({
          tenantId,
          provider: adquirenteDaComanda(),
          agora,
        });
        if (resultado.pagas > 0 || resultado.encerradas > 0) {
          console.log('[cobranca] conciliação', { tenantId, ...resultado });
        }
        return resultado;
      },
      rodarRegua: async (agora) => {
        /**
         * A conciliação vem **antes** da régua, e a ordem é decisão.
         *
         * A rede de segurança fecha o que o webhook não fechou; rodar depois
         * faria a régua da mesma volta enxergar como em aberto uma fatura que
         * já estava paga — e, no dia 21, suspender uma barbearia adimplente por
         * causa de um webhook perdido.
         */
        if (psp) {
          const conciliadas = await conciliarPendentes({ provider: psp });
          if (conciliadas.consultadas > 0) console.log('[cobranca] conciliação', conciliadas);
        }

        const resultado = await aplicarRegua({ agora, provider: cobranca });
        const mexeu = Object.values(resultado).some((n) => n > 0);
        if (mexeu) console.log('[cobranca] régua do dia', resultado);
      },
    },
    {
      intervaloMs: INTERVALO_MS,
      parar: () => parando,
      aoRodar: (resultado: ResultadoDaRodada) => {
        // Rodada vazia é a maioria e não vira linha de log: um worker que
        // escreve a cada cinco segundos enterra o dia em que algo falhou.
        if (resultado.tomadas === 0) return;
        console.log(
          `[worker] ${resultado.tomadas} tarefa(s): ${resultado.concluidas} ok, ` +
            `${resultado.reagendadas} para tentar de novo, ${resultado.falhadas} falha(s)`,
        );
      },
    },
  );

  await disconnect();
  console.log('[worker] encerrado');
}

void main().catch((erro: unknown) => {
  console.error('[worker] parou com erro', erro);
  process.exitCode = 1;
});
