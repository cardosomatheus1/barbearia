#!/usr/bin/env node
/**
 * Cria a primeira conta da plataforma.
 *
 *   node scripts/criar-super-admin.mjs "Nome" email@dominio
 *
 * A senha vem da entrada padrão, ou de `SUPER_ADMIN_PASSWORD` quando o chamador
 * é um script.
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
import { criarAdminDaPlataforma, PlataformaError } from '../packages/platform/dist/index.js';

const [nome, email] = process.argv.slice(2);

if (!nome || !email) {
  console.error('uso: node scripts/criar-super-admin.mjs "Nome" email@dominio');
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
  const admin = await criarAdminDaPlataforma({ nome, email, senha: await lerSenha() });
  console.log(`conta criada: ${admin.nome} (${admin.id})`);
  process.exit(0);
} catch (erro) {
  if (erro instanceof PlataformaError) {
    console.error(erro.message);
    process.exit(1);
  }
  throw erro;
}
