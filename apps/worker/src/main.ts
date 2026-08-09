import { assertRlsEnforced, disconnect } from '@barbearia/db';
import { varrerRetencao } from '@barbearia/crm';
import { conciliarCobrancas } from '@barbearia/finance';
import { primaryLocation } from '@barbearia/scheduling';
import { diaNaUnidade } from '@barbearia/core';
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
      provider: new ConsoleNotificationProvider(),
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
