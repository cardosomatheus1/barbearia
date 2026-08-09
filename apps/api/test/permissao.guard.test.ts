import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PERMISSOES, PERMISSOES_DE_DINHEIRO, ehPermissao } from '@barbearia/core';
import { VALIDADE_DO_SEGUNDO_FATOR_MINUTOS } from '@barbearia/identity';
import { PERMISSAO_EXIGIDA, PermissaoGuard } from '../src/admin/permissao.guard.js';

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

/**
 * O reflector falso, agora com **duas** chaves.
 *
 * Ele devolvia o mesmo valor para qualquer pergunta, e isso deixou de servir no
 * bloco 26: a guarda passou a perguntar também o recurso, e um reflector que
 * responde a lista de permissões nessa pergunta faz a guarda ir ao banco atrás
 * de um recurso chamado "appointments.view". Nenhum teste de unidade deveria
 * abrir conexão, e este começou a abrir sem que nada no seu texto mudasse.
 */
function guardaCom(
  exigidas: readonly string[] | undefined,
  recurso?: string,
): PermissaoGuard {
  const reflector = {
    getAllAndOverride: (chave: string) =>
      chave === PERMISSAO_EXIGIDA ? exigidas : recurso,
  } as unknown as Reflector;
  return new PermissaoGuard(reflector);
}

const DONO = {
  permissions: [...PERMISSOES],
  mustChangePassword: false,
};

/**
 * A guarda passou a ser assíncrona no bloco 26, quando o recurso ligável entrou
 * nela. Estes testes esperam a promessa — e continuam sem banco: o caminho que
 * consultaria `feature_flags` só é tomado quando a rota declara `@Recurso`, e
 * nenhuma destas declara.
 */
describe('guarda de permissão', () => {
  it('deixa passar quem tem a permissão exigida', async () => {
    await expect(guardaCom(['appointments.view']).canActivate(contexto(DONO))).resolves.toBe(true);
  });

  it('recusa quem não tem', async () => {
    const recepcao = { permissions: ['appointments.view'], mustChangePassword: false };
    await expect(
      guardaCom(['team.manage']).canActivate(contexto(recepcao)),
    ).rejects.toThrowError(/não está disponível/i);
  });

  it('exigir duas significa as duas', async () => {
    const meio = { permissions: ['appointments.view'], mustChangePassword: false };
    await expect(
      guardaCom(['appointments.view', 'appointments.cancel']).canActivate(contexto(meio)),
    ).rejects.toThrow();
  });

  it('rota que não declara nada é recusada, não liberada', async () => {
    // Esquecer de declarar tem que virar erro no primeiro teste, não brecha
    // silenciosa que ninguém procura.
    await expect(guardaCom(undefined).canActivate(contexto(DONO))).rejects.toThrowError(
      /não está disponível/i,
    );
  });

  it('sem sessão é 401, não 403', async () => {
    // Quem não se identificou não teve permissão negada — só não se identificou.
    await expect(
      guardaCom(['appointments.view']).canActivate(contexto(undefined)),
    ).rejects.toThrowError(/sessão/i);
  });

  it('quem ainda deve trocar a senha de primeiro acesso não opera nada', async () => {
    const nova = { permissions: [...PERMISSOES], mustChangePassword: true };
    await expect(
      guardaCom(['appointments.view']).canActivate(contexto(nova)),
    ).rejects.toThrowError(/troque a senha/i);
  });

  it('mas consegue chegar à rota que destranca a conta', async () => {
    // `@Exige()` vazio é a única fuga, e existe só para isso.
    const nova = { permissions: [], mustChangePassword: true };
    await expect(guardaCom([]).canActivate(contexto(nova))).resolves.toBe(true);
  });

  it('e a sessão de suporte não passa nem por essa fuga', async () => {
    // `every` sobre lista vazia é verdadeiro: sem a cláusula explícita em
    // `suportePode`, o suporte trocaria a senha do dono por esta mesma porta.
    const suporte = { permissions: [...PERMISSOES], mustChangePassword: false, impersonatedBy: 'a' };
    await expect(guardaCom([]).canActivate(contexto(suporte))).rejects.toThrowError(
      /somente leitura/i,
    );
  });

  it('a sessão de suporte lê, e só', async () => {
    const suporte = { permissions: [...PERMISSOES], mustChangePassword: false, impersonatedBy: 'a' };
    await expect(
      guardaCom(['appointments.view']).canActivate(contexto(suporte)),
    ).resolves.toBe(true);
    await expect(
      guardaCom(['appointments.cancel']).canActivate(contexto(suporte)),
    ).rejects.toThrowError(/somente leitura/i);
    // Exportar a base é o caminho pelo qual dado pessoal sai da barbearia.
    await expect(
      guardaCom(['customers.export']).canActivate(contexto(suporte)),
    ).rejects.toThrowError(/somente leitura/i);
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

        // Sobe o **bloco inteiro** de decoradores, não só a linha de cima. Olhar
        // uma linha só funcionou enquanto `@Exige` era o único decorador de
        // método; no bloco 26 chegou o `@Recurso`, e a varredura passou a
        // acusar de "sem declaração" justamente as rotas mais protegidas.
        let declarada = false;
        for (let j = i - 1; j >= 0; j -= 1) {
          const acima = (linhas[j] ?? '').trim();
          if (acima === '') continue;
          if (!acima.startsWith('@')) break;
          if (acima.startsWith('@Exige(')) {
            declarada = true;
            break;
          }
        }

        if (!declarada) semDeclaracao.push(`${arquivo} ${classe}: ${linha.trim()}`);
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
  it('toda permissão de dinheiro cobra o segundo fator na guarda', async () => {
    const semSegundoFator: string[] = [];

    for (const permissao of PERMISSOES_DE_DINHEIRO) {
      const dono = { ...DONO, mfaEnabled: true, mfaVerifiedAt: null };
      try {
        await guardaCom([permissao]).canActivate(contexto(dono));
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

  it('quem tem a permissão mas não cadastrou o segundo fator recebe outro código', async () => {
    // A tela precisa distinguir "cadastre" de "digite o código": com uma
    // resposta só, quem tem permissão veria "sem permissão" e não teria saída.
    await expect(
      guardaCom(['finance.view']).canActivate(
        contexto({ ...DONO, mfaEnabled: false, mfaVerifiedAt: null }),
      ),
    ).rejects.toThrowError(/ative o segundo fator/i);
  });

  it('a prova do segundo fator vence com o tempo, mesmo com a sessão viva', async () => {
    const dono = (verificadoEm: Date) => ({ ...DONO, mfaEnabled: true, mfaVerifiedAt: verificadoEm });
    const agora = Date.now();

    await expect(
      guardaCom(['finance.view']).canActivate(contexto(dono(new Date(agora)))),
    ).resolves.toBe(true);

    const vencido = new Date(agora - (VALIDADE_DO_SEGUNDO_FATOR_MINUTOS + 1) * 60_000);
    await expect(
      guardaCom(['finance.view']).canActivate(contexto(dono(vencido))),
    ).rejects.toThrowError(/confirme o código/i);
  });

  it('rota sem permissão de dinheiro não pede segundo fator', async () => {
    // A recepção passa o dia marcando horário. Cobrar código aí seria o que
    // faria a barbearia procurar como desligar isso.
    await expect(
      guardaCom(['appointments.create']).canActivate(
        contexto({ ...DONO, mfaEnabled: false, mfaVerifiedAt: null }),
      ),
    ).resolves.toBe(true);
  });

  it('rota marcada com @Recurso pergunta pelo recurso; rota sem @Recurso não', async () => {
    // Sem o segundo argumento nenhuma consulta acontece — é o que mantém este
    // arquivo sendo teste de unidade. Com ele, a guarda vai ao banco, e é isso
    // que o e2e cobre contra Postgres de verdade.
    await expect(
      guardaCom(['appointments.view']).canActivate(contexto(DONO)),
    ).resolves.toBe(true);
  });
});
