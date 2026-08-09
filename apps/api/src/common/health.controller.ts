import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { getPrisma } from '@barbearia/db';
import { FORA_DO_LIMITE } from './throttler.config.js';

/**
 * As duas sondas que um processo em produção precisa expor.
 *
 * Elas respondem perguntas diferentes, e confundi-las é o jeito clássico de um
 * incidente virar dois:
 *
 * - **`/health` (vivo)** — o processo responde. Não toca no banco. Se ele
 *   dissesse "não estou bem" porque o Postgres caiu, o orquestrador **mataria e
 *   recriaria** o container inteiro — durante uma queda de banco, quando a coisa
 *   mais útil que a API pode fazer é continuar de pé devolvendo erro claro.
 * - **`/health/pronto` (pronto)** — dá para atender de verdade: o banco
 *   responde **e** a conexão não ignora RLS. Aqui o certo é sair do balanceador,
 *   e é a resposta que a esteira e o staging conferem depois de subir uma
 *   versão.
 *
 * A checagem de RLS não é enfeite na sonda: `main.ts` já recusa subir sem ela,
 * mas um `ALTER ROLE ... BYPASSRLS` aplicado com o processo no ar não passaria
 * por aquele ponto. É a mesma falha que separaria as barbearias umas das
 * outras, e ela precisa aparecer em algum lugar que a esteira olhe.
 *
 * Sem autenticação e fora do rate limit, de propósito: sonda que depende de
 * segredo é sonda que não roda quando o segredo está errado, e sonda que o
 * balanceador chama a cada segundo esgotaria a cota da janela.
 */

interface Sonda {
  readonly status: 'ok' | 'degradado';
  readonly versao: string;
  readonly desdeSegundos: number;
}

export interface SondaPronto extends Sonda {
  readonly banco: 'ok' | 'inacessivel';
  readonly rls: 'aplicada' | 'ignorada' | 'desconhecida';
}

/**
 * O que é servido, para conferir depois do deploy que subiu o que se pediu.
 * Vem do ambiente porque a esteira é quem sabe o commit — o código não.
 */
const VERSAO = process.env['APP_VERSION'] ?? 'dev';

function estadoDeVivo(): Sonda {
  return {
    status: 'ok',
    versao: VERSAO,
    // `process.uptime()` e não um relógio injetado: isto não é regra de
    // negócio, é o tempo do processo — o número que denuncia container em laço
    // de reinício, que é justamente o que a sonda existe para mostrar.
    desdeSegundos: Math.floor(process.uptime()),
  };
}

/**
 * A decisão da sonda de pronto, separada de quem vai ao banco.
 *
 * Está aqui fora por causa de um teste que passou sozinho e reprovou na suíte:
 * ele provava o caso degradado **pela ausência de um banco**, que é acidente do
 * ambiente e não regra. Com a consulta entrando por parâmetro, os dois lados
 * ficam exercitáveis de verdade — inclusive o de erro, sem derrubar Postgres
 * nenhum.
 */
export async function estadoDePronto(
  consultar: () => Promise<readonly { bypass_rls: boolean }[]>,
): Promise<SondaPronto> {
  const base = estadoDeVivo();

  try {
    const linha = (await consultar())[0];
    if (!linha) return { ...base, status: 'degradado', banco: 'ok', rls: 'desconhecida' };

    const rls = linha.bypass_rls ? 'ignorada' : 'aplicada';
    return { ...base, status: rls === 'aplicada' ? 'ok' : 'degradado', banco: 'ok', rls };
  } catch {
    // O motivo vai para o log do processo pelo próprio Prisma; a sonda é
    // pública e não descreve a falha para quem perguntou (CLAUDE.md §2).
    return { ...base, status: 'degradado', banco: 'inacessivel', rls: 'desconhecida' };
  }
}

@Controller('health')
@SkipThrottle(FORA_DO_LIMITE)
export class HealthController {
  @Get()
  vivo(): Sonda {
    return estadoDeVivo();
  }

  @Get('pronto')
  pronto(): Promise<SondaPronto> {
    return estadoDePronto(
      () => getPrisma().$queryRaw<{ bypass_rls: boolean }[]>`
        SELECT rolbypassrls AS bypass_rls
        FROM pg_roles
        WHERE rolname = current_user
      `,
    );
  }
}
