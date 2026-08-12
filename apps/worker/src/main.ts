import { assertRlsEnforced, disconnect } from '@barbearia/db';
import { respostaParaEnviar, varrerRetencao } from '@barbearia/crm';
import {
  aplicarReguaDoClube,
  conciliarCobrancas,
  conciliarRecebedores,
  liquidarRepasses,
  montarAvisoDoClube,
} from '@barbearia/finance';
import {
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
} from '@barbearia/core';
import {
  avisarDaOperacao,
  CODIGO_DA_RETENCAO,
  ConsoleOperacaoProvider,
} from '@barbearia/platform';
import {
  ConsoleNotificationProvider,
  RELOGIO_REAL,
  rodarWorker,
  type ResultadoDaRodada,
} from '@barbearia/jobs';
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
const provider = new ConsoleNotificationProvider();

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
       * A retenção de dado pessoal (bloco 32), ligada aqui pelo mesmo motivo
       * da cobrança: ela mora em `packages/crm`, e `jobs` não conhece a camada
       * de cima.
       */
      varrerRetencao: async (tenantId, agora) => {
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
        const local = await primaryLocation(tenantId);
        // Barbearia sem unidade não tem comanda, então não há o que conferir.
        if (!local) return { pagas: 0, encerradas: 0 };
        const resultado = await conciliarCobrancas({
          tenantId,
          provider: adquirenteDaComanda(),
          hojeNaUnidade: diaNaUnidade(null, local.timezone, agora).dia,
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
