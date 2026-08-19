import { z } from 'zod';
import { parseDate } from '@barbearia/core';

/**
 * O dia ISO na borda — **um**, para a API inteira (bloco 105).
 *
 * ## O defeito
 *
 * `/^\d{4}-\d{2}-\d{2}$/` estava escrito à mão em dezenove schemas, e a forma
 * não é o conteúdo: ele aceita `2026-02-31`, `2026-13-01`, `2026-00-15` e
 * `0000-00-00`. Quem recusava era `parseDate`, lá dentro, com um `RangeError`
 * que nenhum controller do caminho de gravação traduzia — então
 * `POST /v1/b/:slug/appointments` com `date=2026-02-31` respondia **500**.
 *
 * A segunda ponta é o teto. `dateFrom=9999-12-31` passa por qualquer regex, e
 * o fim de janela (`+1 dia`) estoura para o ano 10000, que o `Date` serializa
 * como `+010000-01-01` — formato que o Prisma recusa em parâmetro cru. Também
 * 500, também anônimo, também numa URL só.
 *
 * ## Por que uma só, e por que aqui
 *
 * É a sexta lista paralela deste código, e as cinco anteriores todas
 * divergiram. Dezenove cópias significam dezenove lugares para consertar o
 * mesmo defeito, e dezenove chances de esquecer um — foi exatamente o que
 * aconteceu com `secoes.ts`, com os rótulos de campanha e com o estado que
 * ocupa uma venda. Há teste que varre `apps/api/src` e reprova quem escrever a
 * vigésima.
 *
 * ## O horizonte
 *
 * `1900` embaixo porque data de nascimento é dado deste produto e uma pessoa de
 * noventa anos nasceu antes de 1940; `2100` em cima porque nenhuma operação de
 * barbearia acontece depois disso e é o que fecha o transbordo do ano. Não é
 * regra de negócio — quem diz até quando se agenda é `MAX_RANGE_DAYS` e a
 * janela da unidade. É o alcance do que o sistema consegue representar, e por
 * isso vale para toda data que entra.
 */
const PRIMEIRO_DIA = '1900-01-01';
const ULTIMO_DIA = '2100-12-31';

function ehDiaDeCalendario(valor: string): boolean {
  try {
    parseDate(valor);
    return true;
  } catch {
    return false;
  }
}

export const diaISO = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD')
  // Comparação de texto resolve: em ISO, a ordem lexicográfica é a cronológica.
  .refine((v) => v >= PRIMEIRO_DIA && v <= ULTIMO_DIA, 'Data fora do período aceito')
  .refine(ehDiaDeCalendario, 'Esse dia não existe no calendário');
