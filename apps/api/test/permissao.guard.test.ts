import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PERMISSOES, PERMISSOES_DE_DINHEIRO, ehPermissao } from '@barbearia/core';
import { VALIDADE_DO_SEGUNDO_FATOR_MINUTOS } from '@barbearia/identity';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';

/**
 * A guarda decide; estes testes cuidam de duas coisas que ela sozinha não
 * garante: que nenhuma rota esqueça de declarar, e que toda rota de dinheiro
 * seja cobrada pelo segundo fator.
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
   * O `CLAUDE.md` exige MFA para papéis com permissão `finance.*`.
   *
   * Até o bloco 18 este teste dizia o contrário — **nenhuma** rota podia exigir
   * uma dessas, porque o segundo fator não existia. Era uma trava: manter a
   * regra verdadeira em vez de escrita, e ficar vermelho no dia em que a
   * primeira tela de dinheiro chegasse, obrigando a decisão a ser tomada junto.
   *
   * Ele ficou vermelho neste bloco e virou o que sempre quis ser: toda rota de
   * dinheiro **é** cobrada pelo segundo fator. E não é uma declaração à parte
   * que alguém possa esquecer — a `PermissaoGuard` deriva a exigência da
   * própria permissão declarada. O que este teste guarda é que ela continue
   * fazendo isso, para toda permissão do grupo.
   */
  it('toda permissão de dinheiro cobra o segundo fator na guarda', () => {
    const semSegundoFator: string[] = [];

    for (const permissao of PERMISSOES_DE_DINHEIRO) {
      const dono = { ...DONO, mfaEnabled: true, mfaVerifiedAt: null };
      try {
        guardaCom([permissao]).canActivate(contexto(dono));
        semSegundoFator.push(permissao);
      } catch {
        // Recusou, que é o esperado: o dono tem a permissão e mesmo assim não
        // passa sem ter provado o código nesta sessão.
      }
    }

    expect(PERMISSOES_DE_DINHEIRO.length, 'o grupo de dinheiro ficou vazio').toBeGreaterThan(0);
    expect(
      semSegundoFator,
      `permissão de dinheiro que passa sem segundo fator: ${semSegundoFator.join(', ')}`,
    ).toEqual([]);
  });

  it('quem tem a permissão mas não cadastrou o segundo fator recebe outro código', () => {
    // A tela precisa distinguir "cadastre" de "digite o código": com uma
    // resposta só, quem tem permissão veria "sem permissão" e não teria saída.
    expect(() =>
      guardaCom(['finance.view']).canActivate(
        contexto({ ...DONO, mfaEnabled: false, mfaVerifiedAt: null }),
      ),
    ).toThrowError(/ative o segundo fator/i);
  });

  it('a prova do segundo fator vence com o tempo, mesmo com a sessão viva', () => {
    const dono = (verificadoEm: Date) => ({ ...DONO, mfaEnabled: true, mfaVerifiedAt: verificadoEm });
    const agora = Date.now();

    expect(guardaCom(['finance.view']).canActivate(contexto(dono(new Date(agora))))).toBe(true);

    const vencido = new Date(agora - (VALIDADE_DO_SEGUNDO_FATOR_MINUTOS + 1) * 60_000);
    expect(() => guardaCom(['finance.view']).canActivate(contexto(dono(vencido)))).toThrowError(
      /confirme o código/i,
    );
  });

  it('rota sem permissão de dinheiro não pede segundo fator', () => {
    // A recepção passa o dia marcando horário. Cobrar código aí seria o que
    // faria a barbearia procurar como desligar isso.
    expect(
      guardaCom(['appointments.create']).canActivate(
        contexto({ ...DONO, mfaEnabled: false, mfaVerifiedAt: null }),
      ),
    ).toBe(true);
  });
});
