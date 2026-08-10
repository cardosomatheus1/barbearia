/**
 * O código de seis dígitos do segundo fator, para quem não tem onde instalar
 * um aplicativo autenticador.
 *
 *   node scripts/codigo-2fa.mjs SEUSEGREDOBASE32
 *
 * ## Por que isto existe
 *
 * As telas de dinheiro — caixa, comanda, fiado, comissão — exigem prova de
 * segundo fator, e a exigência é **derivada da permissão**: não há como
 * desligá-la para uma demonstração sem desligá-la para valer. O caminho normal
 * é ler o código num aplicativo autenticador, e em máquina corporativa
 * bloqueada não há como instalar um.
 *
 * ## O que ele não faz
 *
 * Não lê o banco e não decifra nada. Ele recebe o segredo que a semeadura
 * **já imprimiu na tela** e faz a mesma conta que o celular faria — é uma
 * calculadora de TOTP, não uma porta dos fundos. Um script que fosse buscar o
 * segredo cifrado no banco seria uma ferramenta de extração com nome amigável,
 * e ela não teria por que existir num repositório de produto.
 *
 * Se o segredo se perdeu, o caminho é recomeçar a demonstração
 * (`scripts/rodar-local.sh --zerar`), que sorteia outro e imprime.
 */

const PASSO_SEGUNDOS = 30;

const segredo = (process.argv[2] ?? '').trim().toUpperCase().replace(/\s+/g, '');

if (!segredo) {
  console.error(`
  Faltou o segredo.

      node scripts/codigo-2fa.mjs SEUSEGREDOBASE32

  Ele foi impresso uma vez, quando a barbearia de demonstração foi semeada,
  na linha "segundo fator" — 32 letras e números.

  Perdeu? \x1b[1mscripts/rodar-local.sh --zerar\x1b[0m recomeça e imprime outro.
`);
  process.exit(2);
}

if (!/^[A-Z2-7]+$/.test(segredo)) {
  // Base32 não tem 0, 1, 8 nem 9 — e é justamente aí que a leitura de uma tela
  // erra, trocando O por 0 e I por 1. Dizer isso é mais útil que "código
  // inválido" depois de a conta já ter sido feita.
  console.error(`
  Isso não parece um segredo base32: ele usa só A-Z e 2-7.

  Confira se um "0" não é na verdade um "O", ou um "1" um "I".
`);
  process.exit(2);
}

const { codigoDoPasso, passoAgora } = await import(
  new URL('../packages/identity/dist/mfa.js', import.meta.url)
).catch(() => {
  console.error('\n  Rode `pnpm -r build` antes: este script usa o mesmo código do produto.\n');
  process.exit(1);
});

const agora = new Date();
const passo = passoAgora(agora);
const codigo = codigoDoPasso(segredo, passo);
const faltam = PASSO_SEGUNDOS - (Math.floor(agora.getTime() / 1000) % PASSO_SEGUNDOS);

console.log(`
  \x1b[1m\x1b[32m${codigo}\x1b[0m

  vale por mais ${faltam}s${faltam <= 5 ? ' — se der erro, rode de novo' : ''}
[90m
  Recusado? Um passo de 30s só vale uma vez. Logo depois da semeadura os dois
  primeiros já foram consumidos por ela — espere meio minuto e peça de novo.[0m
`);
