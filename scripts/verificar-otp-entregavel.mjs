#!/usr/bin/env node
/**
 * `IDENTITY_MESSAGING_MODO=console` é seguro? Pergunte ao banco.
 *
 * O preflight recusava `console` em produção sem alternativa, e a intenção era
 * certa: em modo console o OTP e a senha de primeiro acesso são **escritos no
 * log em vez de enviados**, e quem está do outro lado espera um código que
 * nunca chega. Silêncio é o pior desfecho possível numa porta de entrada.
 *
 * Mas a recusa era cega, e por isso cara demais: ela bloqueava todo deploy —
 * inclusive commits sem relação nenhuma com mensageria — até alguém contratar
 * uma WABA, aprovar dois templates na Meta e esperar dias pela aprovação.
 * Guarda que bloqueia trabalho não relacionado por prazo indeterminado é guarda
 * que alguém acaba apagando, e aí não sobra nem a proteção nem o registro.
 *
 * ## O que de fato depende da entrega
 *
 * Duas coisas usam o provider de identidade, e elas não são iguais:
 *
 * - **A senha de primeiro acesso** tem saída pela tela: `criarConta` devolve
 *   `senhaInicial` e o painel a mostra uma vez, atrás do cookie de dois
 *   minutos. A mensagem é conveniência, não o único caminho.
 * - **O OTP do agendamento** não tem. Se `locations.require_otp_for_booking`
 *   estiver ligado e a mensagem não sair, o cliente digita o telefone e trava.
 *
 * Então a pergunta certa não é "o modo é console?" — é **"alguém depende do
 * OTP?"**. Ela é derivada do dado, não declarada num `.env`: uma barbearia que
 * ligar o OTP amanhã faz o próximo deploy reprovar sozinho, sem depender de
 * ninguém lembrar de tirar uma variável de acknowledgment.
 *
 * ## Por que roda depois das migrações
 *
 * `preparar` roda antes delas, e numa instalação nova o banco e a coluna ainda
 * não existem. Consultar ali obrigaria a tratar "tabela ausente" como zero, que
 * é a mesma resposta que "ninguém ligou" — indistinguível de um `psql` que
 * falhou por outro motivo. Depois das migrações a pergunta é sempre respondível,
 * e falha de conexão volta a significar falha de verdade.
 */
import { execFileSync } from 'node:child_process';

const PRODUCAO = process.env['NODE_ENV'] === 'production';

/** Quantas unidades exigem OTP. `null` quando não deu para perguntar. */
export function unidadesComOtp(executar = padraoDoPsql) {
  try {
    const bruto = executar('SELECT count(*) FROM locations WHERE require_otp_for_booking');
    const n = Number.parseInt(bruto.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function padraoDoPsql(sql) {
  const url = process.env['DATABASE_URL'] ?? '';
  if (!url) throw new Error('DATABASE_URL ausente');
  return execFileSync('psql', [url, '-tAc', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function erroDaEntregaDeOtp({ modo, producao, unidades }) {
  if (!producao) return null;
  if (modo === 'meta') return null;
  if (modo !== 'console') {
    return `IDENTITY_MESSAGING_MODO inválido: ${modo}. Use console ou meta.`;
  }
  if (unidades === null) {
    // Fecha por falta de resposta: sem saber se alguém depende do OTP, liberar
    // seria a guarda decidindo pelo caso melhor justamente quando está cega.
    return 'não deu para conferir quem depende do OTP; com IDENTITY_MESSAGING_MODO=console isso recusa o deploy';
  }
  if (unidades > 0) {
    return (
      `${unidades} unidade(s) exigem OTP no agendamento e IDENTITY_MESSAGING_MODO=console ` +
      'não entrega mensagem: o cliente pediria o código e ele não chegaria. ' +
      'Desligue a exigência de OTP nessas unidades ou configure IDENTITY_MESSAGING_MODO=meta.'
    );
  }
  return null;
}

const direto = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (direto) {
  const modo = (process.env['IDENTITY_MESSAGING_MODO'] ?? 'console').trim();
  const unidades = modo === 'console' && PRODUCAO ? unidadesComOtp() : 0;
  const erro = erroDaEntregaDeOtp({ modo, producao: PRODUCAO, unidades });
  if (erro) {
    console.error(`entrega de OTP recusada:\n  - ${erro}`);
    process.exit(1);
  }
  if (PRODUCAO && modo === 'console') {
    console.warn(
      'AVISO: IDENTITY_MESSAGING_MODO=console — OTP e senha de primeiro acesso vão para o log, ' +
        'não para o cliente. Nenhuma unidade exige OTP hoje, então nada está travado; ' +
        'ligar a exigência sem configurar a Meta vai recusar o próximo deploy.',
    );
  }
  console.log('entrega de OTP: ok');
}
