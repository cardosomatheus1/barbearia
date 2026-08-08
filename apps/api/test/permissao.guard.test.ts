import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PERMISSOES, PERMISSOES_DE_DINHEIRO, ehPermissao } from '@barbearia/core';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';

/**
 * A guarda decide; estes testes cuidam de duas coisas que ela sozinha não
 * garante: que nenhuma rota esqueça de declarar, e que nenhuma exija dinheiro
 * antes de existir segundo fator.
 */

const CONTROLLERS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'admin');

/**
 * Cada **classe** de controller, com o próprio corpo.
 *
 * Por classe e não por arquivo: `admin.controller.ts` tem duas, e uma delas é
 * o cadastro público, que não fica atrás de guarda nenhuma. A primeira versão
 * deste teste filtrava por arquivo e acusava `signup` e `login` de não
 * declararem permissão — o que seria correto exigir de uma rota do painel e
 * absurdo de uma rota de login.
 */
function controllers(): { arquivo: string; classe: string; corpo: string; guardada: boolean }[] {
  const encontrados: { arquivo: string; classe: string; corpo: string; guardada: boolean }[] = [];

  for (const nome of readdirSync(CONTROLLERS).filter((n) => n.endsWith('.controller.ts'))) {
    const fonte = readFileSync(join(CONTROLLERS, nome), 'utf8');
    const marcos = [...fonte.matchAll(/export class (\w+)/g)];

    for (const [i, marco] of marcos.entries()) {
      const inicio = marco.index ?? 0;
      const fim = marcos[i + 1]?.index ?? fonte.length;
      // Os decoradores da classe ficam **antes** de `export class`, depois do
      // fim da classe anterior.
      const anterior = i === 0 ? 0 : (marcos[i - 1]?.index ?? 0);
      const cabecalho = fonte.slice(anterior, inicio);

      encontrados.push({
        arquivo: nome,
        classe: marco[1] ?? '',
        corpo: fonte.slice(inicio, fim),
        guardada: /@UseGuards\([^)]*PermissaoGuard/.test(cabecalho),
      });
    }
  }

  return encontrados;
}

/** Um contexto de execução falso, com o que a guarda de fato lê. */
function contexto(staff: unknown): ExecutionContext {
  const alvo = () => undefined;
  return {
    getHandler: () => alvo,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ staff }) }),
  } as unknown as ExecutionContext;
}

function guardaCom(exigidas: readonly string[] | undefined): PermissaoGuard {
  const reflector = {
    getAllAndOverride: () => exigidas,
  } as unknown as Reflector;
  return new PermissaoGuard(reflector);
}

const DONO = {
  permissions: [...PERMISSOES],
  mustChangePassword: false,
};

describe('guarda de permissão', () => {
  it('deixa passar quem tem a permissão exigida', () => {
    expect(guardaCom(['appointments.view']).canActivate(contexto(DONO))).toBe(true);
  });

  it('recusa quem não tem', () => {
    const recepcao = { permissions: ['appointments.view'], mustChangePassword: false };
    expect(() => guardaCom(['team.manage']).canActivate(contexto(recepcao))).toThrowError(
      /não está disponível/i,
    );
  });

  it('exigir duas significa as duas', () => {
    const meio = { permissions: ['appointments.view'], mustChangePassword: false };
    expect(() =>
      guardaCom(['appointments.view', 'appointments.cancel']).canActivate(contexto(meio)),
    ).toThrow();
  });

  it('rota que não declara nada é recusada, não liberada', () => {
    // Esquecer de declarar tem que virar erro no primeiro teste, não brecha
    // silenciosa que ninguém procura.
    expect(() => guardaCom(undefined).canActivate(contexto(DONO))).toThrowError(
      /não está disponível/i,
    );
  });

  it('sem sessão é 401, não 403', () => {
    // Quem não se identificou não teve permissão negada — só não se identificou.
    expect(() => guardaCom(['appointments.view']).canActivate(contexto(undefined))).toThrowError(
      /sessão/i,
    );
  });

  it('quem ainda deve trocar a senha de primeiro acesso não opera nada', () => {
    const nova = { permissions: [...PERMISSOES], mustChangePassword: true };
    expect(() => guardaCom(['appointments.view']).canActivate(contexto(nova))).toThrowError(
      /troque a senha/i,
    );
  });

  it('mas consegue chegar à rota que destranca a conta', () => {
    // `@Exige()` vazio é a única fuga, e existe só para isso.
    const nova = { permissions: [], mustChangePassword: true };
    expect(guardaCom([]).canActivate(contexto(nova))).toBe(true);
  });
});

describe('as rotas do painel', () => {
  it('toda rota declara uma permissão', () => {
    // Conta os decoradores de método e os `@Exige` de cada controller. Rota a
    // mais sem declaração é rota que a guarda recusaria em produção — melhor
    // descobrir aqui.
    const semDeclaracao: string[] = [];

    for (const { arquivo, classe, corpo, guardada } of controllers()) {
      if (!guardada) continue;

      const linhas = corpo.split('\n');
      for (const [i, linha] of linhas.entries()) {
        if (!/^\s*@(Get|Post|Put|Patch|Delete)\(/.test(linha)) continue;
        const anterior = linhas[i - 1] ?? '';
        if (!anterior.includes('@Exige(')) {
          semDeclaracao.push(`${arquivo} ${classe}: ${linha.trim()}`);
        }
      }
    }

    // Guarda do próprio guarda: se a varredura parar de achar rota, ela para de
    // provar qualquer coisa e passa em silêncio.
    const guardadas = controllers().filter((c) => c.guardada);
    expect(guardadas.length, 'nenhum controller guardado foi encontrado').toBeGreaterThan(2);

    expect(semDeclaracao, `rota sem @Exige:\n${semDeclaracao.join('\n')}`).toEqual([]);
  });

  it('toda permissão exigida existe no catálogo', () => {
    // Permissão escrita errada numa rota recusaria todo mundo, em silêncio —
    // e o defeito só apareceria como "o sistema não deixa" de alguém.
    const desconhecidas: string[] = [];

    for (const { arquivo, corpo } of controllers()) {
      for (const [, lista = ''] of corpo.matchAll(/@Exige\(([^)]*)\)/g)) {
        for (const [, nome = ''] of lista.matchAll(/'([^']+)'/g)) {
          if (!ehPermissao(nome)) desconhecidas.push(`${arquivo}: ${nome}`);
        }
      }
    }

    expect(desconhecidas, `permissão inexistente: ${desconhecidas.join(', ')}`).toEqual([]);
  });

  /**
   * O `CLAUDE.md` exige MFA para papéis com permissão `finance.*`, e não há
   * segundo fator neste sistema ainda.
   *
   * Enquanto não houver, nenhuma rota pode exigir uma dessas — é o que mantém a
   * regra verdadeira em vez de escrita. Quando a primeira tela de faturamento
   * chegar (bloco 18), este teste fica vermelho e obriga a decisão a ser tomada
   * junto, e não seis blocos depois.
   */
  it('nenhuma rota exige permissão de dinheiro enquanto não existe MFA', () => {
    const comDinheiro: string[] = [];

    for (const { arquivo, corpo } of controllers()) {
      for (const [, lista = ''] of corpo.matchAll(/@Exige\(([^)]*)\)/g)) {
        for (const permissao of PERMISSOES_DE_DINHEIRO) {
          if (lista.includes(`'${permissao}'`)) comDinheiro.push(`${arquivo}: ${permissao}`);
        }
      }
    }

    expect(
      comDinheiro,
      `rota exige permissão de dinheiro sem MFA implementado: ${comDinheiro.join(', ')}`,
    ).toEqual([]);
  });
});
