#!/usr/bin/env node
/**
 * Cria a primeira conta da plataforma.
 *
 *   node scripts/criar-super-admin.mjs "Nome" email@dominio [--operador]
 *
 * A senha vem da entrada padrão, ou de `SUPER_ADMIN_PASSWORD` quando o chamador
 * é um script.
 *
 * ## Por que `--operador` existe
 *
 * Conta nova nasce `viewer`, e essa regra está certa: quem chega não age sobre
 * a conta de ninguém. Só que **não há rota que promova** — nem na tela de
 * segurança, nem na API —, e `criar-super-admin.mjs` era a única porta. O
 * resultado é o estado sem saída do `CLAUDE.md` §6 um nível acima: a plataforma
 * inteira sem ninguém capaz de bloquear uma barbearia inadimplente, de trocar
 * um plano ou de encerrar uma sessão de suporte, e a única saída sendo um
 * `UPDATE` à mão que nada documentava.
 *
 * O percurso da medição foi quem encontrou: ele tentou reativar uma barbearia
 * pela tela e não achou nenhuma bloqueada — o bloqueio da semente vinha
 * respondendo 403 em silêncio havia blocos, e o cartão "bloqueada" que a
 * medição diz fotografar nunca existiu.
 *
 * A promoção continua sendo de quem tem o banco, como a criação. O que muda é
 * ela ser **dita** em vez de improvisada, e o padrão continua `viewer`.
 *
 * ## Por que isto é um comando e não uma rota
 *
 * A tela `/plataforma/entrar` pede e-mail e senha de uma conta que nada no
 * produto sabia criar — o que faria deste bloco uma porta sem chave. A saída
 * óbvia seria uma rota de cadastro, e ela seria a pior decisão possível: um
 * `POST /v1/plataforma/signup` público é um caminho para qualquer pessoa na
 * internet virar administradora de todas as barbearias, e nenhum "só a primeira
 * conta" resolve — o dia em que a primeira for apagada, a porta reabre.
 *
 * Quem cria conta de plataforma é quem tem acesso ao banco de produção. Isso é
 * uma decisão, não uma limitação.
 *
 * Rodar de novo com o mesmo e-mail é recusado, e é assim que se descobre que a
 * conta já existe sem precisar consultar nada.
 */
import { createInterface } from 'node:readline';
import {
  criarAdminDaPlataforma,
  PlataformaError,
  reconfigurarAdminDaPlataforma,
} from '../packages/platform/dist/index.js';

const argumentos = process.argv.slice(2);
const papel = argumentos.includes('--operador') ? 'operator' : 'viewer';

/**
 * Trocar senha, desligar e religar — as três que faltavam.
 *
 * `password_hash` nunca recebia `UPDATE` em lugar nenhum do repositório, e
 * `disabled_at` era lido no login e escrito por ninguém: a conta que bloqueia
 * qualquer barbearia e entra na conta de qualquer dono não tinha rotação de
 * senha nem desligamento. Criar de novo é recusado por e-mail repetido, então
 * a única saída era `UPDATE` à mão — o mesmo estado sem saída que o
 * `--operador` corrigiu para o papel.
 */
const trocarSenha = argumentos.includes('--trocar-senha');
const desativar = argumentos.includes('--desativar');
const reativar = argumentos.includes('--reativar');

const posicionais = argumentos.filter((a) => !a.startsWith('--'));
const reconfigurar = trocarSenha || desativar || reativar;
// Nas três, o e-mail basta: a conta já existe e o nome não muda.
const [nome, email] = reconfigurar ? [posicionais[0], posicionais[0]] : posicionais;

if (desativar && reativar) {
  console.error('--desativar e --reativar são opostos; escolha um.');
  process.exit(2);
}

if (!nome || !email) {
  console.error(
    'uso: node scripts/criar-super-admin.mjs "Nome" email@dominio [--operador]\n' +
      '     node scripts/criar-super-admin.mjs email@dominio --trocar-senha\n' +
      '     node scripts/criar-super-admin.mjs email@dominio --desativar | --reativar',
  );
  process.exit(2);
}

if (!process.env['DATABASE_URL']) {
  console.error('DATABASE_URL é obrigatória.');
  process.exit(2);
}
if (!process.env['STAFF_EMAIL_PEPPER']) {
  console.error('STAFF_EMAIL_PEPPER é obrigatória — sem ela o índice de login fica em claro.');
  process.exit(2);
}

async function lerSenha() {
  const doAmbiente = process.env['SUPER_ADMIN_PASSWORD'];
  if (doAmbiente) return doAmbiente;

  // A senha não pode ficar no histórico do shell — que é o que aconteceria se
  // ela fosse argumento — nem na rolagem do terminal, que numa máquina de
  // produção costuma ser gravada.
  //
  // O `readline` com `terminal: true` **ecoa** o que é digitado, e a primeira
  // versão daqui trazia um comentário dizendo o contrário. Silenciar exige
  // substituir `_writeToOutput`; sem isso a senha da conta mais poderosa do
  // sistema aparece em claro na tela de quem a está criando.
  const leitor = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  process.stderr.write('Senha (mínimo 12 caracteres): ');
  leitor._writeToOutput = () => {};

  const senha = await new Promise((resolver) => leitor.question('', resolver));
  leitor.close();
  process.stderr.write('\n');
  return senha;
}

try {
  if (reconfigurar) {
    const alvo = await reconfigurarAdminDaPlataforma({
      email,
      ...(trocarSenha ? { senha: await lerSenha() } : {}),
      ...(desativar ? { desligar: true } : {}),
      ...(reativar ? { desligar: false } : {}),
    });
    const oque = trocarSenha ? 'senha trocada' : desativar ? 'conta desligada' : 'conta religada';
    console.log(`${oque}: ${alvo.id} — ${alvo.sessoesRevogadas} sessão(ões) revogada(s)`);
    process.exit(0);
  }

  const admin = await criarAdminDaPlataforma({ nome, email, senha: await lerSenha(), papel });
  console.log(`conta criada: ${admin.nome} (${admin.id}) — ${admin.papel}`);
  process.exit(0);
} catch (erro) {
  if (erro instanceof PlataformaError) {
    console.error(erro.message);
    process.exit(1);
  }
  throw erro;
}
