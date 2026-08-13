import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * O carimbo assinado da passagem pelo marketplace (bloco 72, SPEC §5.2).
 *
 * ## Por que um carimbo assinado, e não a palavra "marketplace"
 *
 * A comissão sobre cliente novo é dinheiro, e a origem do agendamento é o que a
 * decide. A primeira versão gravava um cookie com o texto `marketplace` e a
 * borda da API aceitava o rótulo — o que deixava duas portas abertas, as duas
 * achadas na revisão deste bloco: um terceiro publicava `/ir/{slug}` num
 * anúncio e carimbava o navegador de quem nunca viu a busca, e um `curl`
 * mandava o rótulo direto no corpo.
 *
 * ## Quem emite é a **busca**, quem confere é a **borda do agendamento**
 *
 * O carimbo sai junto de cada card em `GET /v1/marketplace/busca` e volta no
 * `POST` de agendamento. O `apps/web` só o carrega: ele não assina nada, porque
 * a seta vai de `web` para `api` e trazer um pacote com acesso a banco para
 * dentro do servidor de páginas seria abri-la ao contrário por uma função de
 * dez linhas.
 *
 * ## Ele mora em `identity` pelo mesmo motivo do pepper do e-mail
 *
 * É criptografia com segredo de ambiente. `packages/core` não pode hospedá-la:
 * ele não tem `@types/node` de propósito, e essa ausência é a fronteira de
 * pureza dele em forma executável.
 */

/** Quanto tempo o carimbo vale. O mesmo da janela de atribuição. */
const VALIDADE_MS = 30 * 86_400_000;

/** Piso do segredo. Abaixo disso a assinatura é adivinhável. */
const SEGREDO_MINIMO = 16;

function segredo(): string {
  const valor = process.env['MARKETPLACE_ORIGIN_SECRET'];
  /**
   * Falha alto, nunca um padrão fraco em silêncio.
   *
   * Um segredo vazio faria a assinatura ser previsível, e o carimbo voltaria a
   * ser a palavra "marketplace" com passos a mais — dinheiro decidido por quem
   * manda a requisição. É a mesma postura de `STAFF_EMAIL_PEPPER` e de
   * `MFA_SECRET_KEY`.
   */
  if (!valor || valor.length < SEGREDO_MINIMO) {
    throw new Error(
      'MARKETPLACE_ORIGIN_SECRET é obrigatória — sem ela a origem do agendamento é forjável',
    );
  }
  return valor;
}

const assinar = (dados: string): string =>
  createHmac('sha256', segredo()).update(dados).digest('base64url');

/**
 * Emite o carimbo para uma barbearia.
 *
 * O slug entra na assinatura: sem ele, o carimbo tirado da busca de uma casa
 * valeria na página de qualquer outra, e a comissão sairia da barbearia errada.
 */
export function carimbarOrigem(slug: string, agora: Date): string {
  const instante = String(agora.getTime());
  return `${instante}.${assinar(`${slug}.${instante}`)}`;
}

/**
 * Confere o carimbo. Devolve `false` para qualquer coisa que não seja um
 * carimbo válido e dentro do prazo — nunca lança por entrada malformada.
 *
 * Entrada malformada aqui não é ataque a ser anunciado: é um cookie velho, um
 * navegador que guardou lixo, uma requisição de robô. O certo é "não veio pela
 * busca", que é um desfecho legítimo.
 */
export function conferirOrigem(carimbo: string, slug: string, agora: Date): boolean {
  const partes = carimbo.split('.');
  if (partes.length !== 2) return false;
  const [instante, assinatura] = partes as [string, string];

  const quando = Number(instante);
  if (!Number.isFinite(quando)) return false;
  const idade = agora.getTime() - quando;
  // As duas pontas: um carimbo do futuro é relógio adulterado, não navegação.
  if (idade < 0 || idade > VALIDADE_MS) return false;

  const esperada = Buffer.from(assinar(`${slug}.${instante}`), 'utf8');
  const recebida = Buffer.from(assinatura, 'utf8');
  // Comparação em tempo constante, como a do webhook do adquirente.
  if (esperada.length !== recebida.length) return false;
  return timingSafeEqual(esperada, recebida);
}
