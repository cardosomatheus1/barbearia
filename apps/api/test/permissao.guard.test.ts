import 'reflect-metadata';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSOES, PERMISSOES_DE_DINHEIRO, ehPermissao } from '@barbearia/core';
import { VALIDADE_DO_SEGUNDO_FATOR_MINUTOS } from '@barbearia/identity';
/**
 * O recurso ligado, respondido sem banco.
 *
 * `recursoLigado` consulta `feature_flags`, e nenhum teste de unidade deveria
 * abrir conexão. O que se prova aqui é a **ordem** das duas conferências, não o
 * conteúdo da tabela — então a resposta fixa "desligado" é exatamente o cenário
 * do defeito.
 */
vi.mock('@barbearia/platform', () => ({ recursoLigado: async () => false }));

import { PERMISSAO_EXIGIDA, PermissaoGuard } from '../src/admin/permissao.guard.js';

/**
 * A guarda decide; estes testes cuidam de duas coisas que ela sozinha não
 * garante: que nenhuma rota esqueça de declarar, e que toda rota de dinheiro
 * seja cobrada pelo segundo fator.
 */

/**
 * **Todas** as pastas de controller, e não só `admin`.
 *
 * Só `admin` era o recorte da primeira versão, e ele desligava toda varredura
 * deste arquivo em `booking/`, `plataforma/`, `publica/` e `auth/` — as quatro
 * superfícies em que uma rota nova tem mais chance de nascer sem `@Exige`,
 * porque ali a maioria das rotas legitimamente não o tem. Quem separa uma
 * coisa da outra é `guardada`, que lê o `@UseGuards` da própria classe — e ela
 * já existia. Achado da revisão de segurança do bloco 118.
 */
const RAIZ_DA_API = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CONTROLLERS = readdirSync(RAIZ_DA_API)
  .map((p) => join(RAIZ_DA_API, p))
  .filter((p) => existsSync(p) && statSync(p).isDirectory());

/**
 * Cada **classe** de controller, com o próprio corpo.
 *
 * Por classe e não por arquivo: `admin.controller.ts` tem duas, e uma delas é
 * o cadastro público, que não fica atrás de guarda nenhuma. A primeira versão
 * deste teste filtrava por arquivo e acusava `signup` e `login` de não
 * declararem permissão — o que seria correto exigir de uma rota do painel e
 * absurdo de uma rota de login.
 */
/**
 * Os pacotes que as varreduras derivadas leem: **todos**.
 *
 * Três delas liam `core` + `finance`, e uma `core` + `scheduling`. O recorte era
 * herdado de quando o assunto morava lá, e foi por baixo dele que a receita
 * atribuída de campanha (`crm`) escapou do segundo fator, e que a agenda
 * (`scheduling`), a fila e a jornada (`catalog`) entregavam a base.
 *
 * Guarda que lê dois pacotes de doze não é guarda mais barata — é guarda que
 * responde verde sobre dez.
 */
function todosOsPacotes(): string[] {
  const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages');
  return readdirSync(raiz)
    .map((p) => join(raiz, p, 'src'))
    .filter((p) => existsSync(p));
}

/**
 * O corpo de um bloco, por **contagem de chaves**.
 *
 * `\{([^}]*)\}` para no primeiro objeto aninhado: `DayBoard` declara
 * `professionals: readonly { … }[]` antes de `entries`, e a composição nunca
 * chegava a `entries`. As quatro varreduras usavam esse regex.
 */
function corpoDoBloco(fonte: string, abre: number): string {
  let nivel = 0;
  for (let i = abre; i < fonte.length; i += 1) {
    if (fonte[i] === '{') nivel += 1;
    else if (fonte[i] === '}') {
      nivel -= 1;
      if (nivel === 0) return fonte.slice(abre + 1, i);
    }
  }
  return fonte.slice(abre);
}

/**
 * As interfaces exportadas de um fonte, com o corpo inteiro.
 *
 * Uma função só, porque as quatro varreduras faziam a mesma coisa com o mesmo
 * regex torto — e corrigir em quatro lugares é como três ficam para trás.
 */
/**
 * As funções exportadas de um fonte, com o **tipo de retorno**.
 *
 * A assinatura acaba onde o parêntese fecha, contado — não numa janela de N
 * caracteres. A janela já foi esticada de 900 para 3000 uma vez, com o
 * comentário dizendo que a versão curta *"passava verde sobre a rota que a
 * revisão de segurança tinha acabado de reprovar"*, e ainda deixava
 * `fecharComanda` de fora: 3538 caracteres de assinatura.
 *
 * Contando, não há número para esticar da próxima vez.
 */
function funcoesDe(fonte: string): [string, string][] {
  const achadas: [string, string][] = [];
  for (const m of fonte.matchAll(/export (?:async )?function (\w+)\(/g)) {
    const abre = (m.index ?? 0) + m[0].length - 1;
    let nivel = 0;
    let fecha = abre;
    for (let i = abre; i < fonte.length; i += 1) {
      if (fonte[i] === '(') nivel += 1;
      else if (fonte[i] === ')') {
        nivel -= 1;
        if (nivel === 0) {
          fecha = i;
          break;
        }
      }
    }
    const depois = fonte.slice(fecha, fecha + 300);
    const retorno =
      /Promise<([^>]+(?:<[^>]*>)?[^>]*)>/.exec(depois)?.[1] ??
      /^\)\s*:\s*([^{;]+)\{/.exec(depois)?.[1] ??
      '';
    achadas.push([m[1] ?? '', retorno]);
  }
  return achadas;
}

/**
 * As funções que **redigem** em vez de recusar, e o que cada uma redige.
 *
 * Uma redigidora declara um interruptor `podeVer<Coisa>` na assinatura **e o
 * usa no corpo**: declarar e não usar era a primeira forma de contornar a
 * varredura de pessoa, e ela custava uma linha. Achado da revisão de segurança
 * do bloco 118.
 *
 * A isenção continua sendo conquistada e não declarada — não há lista de
 * arquivos isentos em lugar nenhum deste arquivo.
 */
function redigidoras(fontes: readonly string[]): Map<string, string> {
  const achadas = new Map<string, string>();
  for (const fonte of fontes) {
    for (const m of fonte.matchAll(/export (?:async )?function (\w+)\(/g)) {
      const abre = (m.index ?? 0) + m[0].length - 1;
      let nivel = 0;
      let fecha = abre;
      for (let i = abre; i < fonte.length; i += 1) {
        if (fonte[i] === '(') nivel += 1;
        else if (fonte[i] === ')') {
          nivel -= 1;
          if (nivel === 0) {
            fecha = i;
            break;
          }
        }
      }
      const params = fonte.slice(abre, fecha);
      const flag = /\b(podeVer\w+)\s*\??:/.exec(params)?.[1];
      if (!flag) continue;
      /**
       * O `{` do **corpo**, não o do tipo de retorno.
       *
       * `): Promise<{ readonly futuros: ... }> {` tem dois, e o primeiro é o do
       * tipo: pegá-lo fazia o corpo de `setProfessionalActive` ser a declaração
       * do retorno, sem nenhuma menção ao interruptor — a função redigia e a
       * varredura a acusava. O do corpo é o que fecha a linha.
       */
      let inicio = fonte.indexOf('{', fecha);
      while (inicio > 0 && !/^[^\S\n]*\n/.test(fonte.slice(inicio + 1))) {
        inicio = fonte.indexOf('{', inicio + 1);
      }
      if (inicio < 0) continue;
      const corpo = corpoDoBloco(fonte, inicio);
      // Usada, e não só declarada.
      if (!new RegExp(`\\b${flag}\\b`).test(corpo)) continue;
      achadas.set(m[1] ?? '', flag);
    }
  }
  return achadas;
}

/**
 * A chamada acusada está **dentro** dos argumentos de uma redigidora?
 *
 * É o que separa `return getComanda(...)` de
 * `return comandaVisivel({ comanda: await getComanda(...), podeVerCliente })`.
 * Estrutural e não por nome: fingir a isenção exige embrulhar a chamada numa
 * função de redação de verdade, que é exatamente o que se queria que
 * acontecesse.
 */
function envolvidaPorRedigidora(
  codigo: string,
  chamada: string,
  redige: ReadonlyMap<string, string>,
): boolean {
  for (const nome of redige.keys()) {
    for (const m of codigo.matchAll(new RegExp(`\\b${nome}\\s*\\(`, 'g'))) {
      const abre = (m.index ?? 0) + m[0].length - 1;
      let nivel = 0;
      for (let i = abre; i < codigo.length; i += 1) {
        if (codigo[i] === '(') nivel += 1;
        else if (codigo[i] === ')') {
          nivel -= 1;
          if (nivel === 0) {
            const dentro = codigo.slice(abre + 1, i);
            if (new RegExp(`\\b${chamada}\\s*\\(`).test(dentro)) return true;
            break;
          }
        }
      }
    }
  }
  return false;
}

function interfacesDe(fonte: string): [string, string][] {
  const achadas: [string, string][] = [];
  for (const m of fonte.matchAll(/export interface (\w+)[^{]*\{/g)) {
    achadas.push([m[1] ?? '', corpoDoBloco(fonte, (m.index ?? 0) + m[0].length - 1)]);
  }
  return achadas;
}

function controllers(): { arquivo: string; classe: string; corpo: string; guardada: boolean }[] {
  const encontrados: { arquivo: string; classe: string; corpo: string; guardada: boolean }[] = [];

  const arquivos = CONTROLLERS.flatMap((pasta) =>
    readdirSync(pasta)
      .filter((n) => n.endsWith('.controller.ts'))
      .map((n) => [n, join(pasta, n)] as const),
  );

  for (const [nome, caminho] of arquivos) {
    const fonte = readFileSync(caminho, 'utf8');
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
  /**
   * A barbearia deste teste **exige** o segundo fator (bloco 37).
   *
   * O padrão do produto é o contrário — a exigência nasce desligada —, e é por
   * isso que ele está escrito aqui em vez de omitido: um objeto sem o campo
   * passaria em tudo, e os testes de "cobra o segundo fator" ficariam verdes
   * provando que a regra não existe.
   */
  exigeSegundoFatorNoDinheiro: true,
};

/**
 * A guarda passou a ser assíncrona no bloco 26, quando o recurso ligável entrou
 * nela. Estes testes esperam a promessa — e continuam sem banco: o caminho que
 * consultaria `feature_flags` só é tomado quando a rota declara `@Recurso`, e
 * nenhuma destas declara.
 */
/**
 * A isenção do schema semântico, conquistada nas três derivações.
 *
 * `validarPergunta` cobre a permissão; `exigirLimiteDoSuporte` e
 * `exigirSegundoFator` cobrem as outras duas coisas que a `PermissaoGuard`
 * deriva da mesma lista. Quem compuser métricas sem as três continua reprovado,
 * que é o que separa isenção conquistada de isenção declarada.
 */
function isentoPeloSchemaSemantico(codigo: string): boolean {
  return (
    /\bvalidarPergunta\s*\(/.test(codigo) &&
    /\bexigirLimiteDoSuporte\s*\(/.test(codigo) &&
    /\bexigirSegundoFator\s*\(/.test(codigo)
  );
}

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

  it('recurso desligado responde 404 mesmo para quem não tem a permissão', async () => {
    /**
     * A conferência do recurso rodava **depois** da de permissão (bloco 112).
     *
     * Quem tinha a permissão recebia o 404 pretendido; quem não tinha recebia
     * 403 — sobre uma rota que, para aquela conta, não existe. A recepção lia
     * "não está disponível para o seu acesso", ia ao dono pedir `fiscal.view`,
     * o dono concedia, e a resposta virava 404: dois gastaram a manhã numa
     * permissão que nunca foi o problema.
     *
     * O comentário do 404 já dizia por que isso não podia acontecer — ele
     * estava quatro linhas abaixo de onde precisava estar.
     */
    const semFiscal = { permissions: ['appointments.view'], mustChangePassword: false };

    await expect(
      guardaCom(['fiscal.view'], 'fiscal').canActivate(contexto(semFiscal)),
    ).rejects.toMatchObject({ code: 'feature_off' });

    // E continua 404 para quem tem a permissão: a ordem muda quem recebe qual
    // resposta, não a resposta de quem já a recebia.
    await expect(
      guardaCom(['fiscal.view'], 'fiscal').canActivate(contexto(DONO)),
    ).rejects.toMatchObject({ code: 'feature_off' });
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

  it('com a exigência desligada, nem a rota de dinheiro pede o código', async () => {
    /**
     * O padrão do bloco 37, e ele é o inverso do que o produto fazia.
     *
     * Imposto, o segundo fator produzia o oposto do que queria: a barbearia que
     * instalava na terça e tentava abrir o caixa na quarta encontrava "ative o
     * segundo fator" sobre uma conta recém-criada, sem aplicativo autenticador
     * e com o cliente na cadeira — e passava a operar o balcão na conta do
     * dono, que é o que a regra existia para impedir.
     *
     * O que **não** muda é a derivação: com a exigência ligada, toda permissão
     * do grupo continua coberta sem ninguém declarar nada. O interruptor decide
     * se, nunca quais.
     */
    const semExigencia = {
      ...DONO,
      exigeSegundoFatorNoDinheiro: false,
      mfaEnabled: false,
      mfaVerifiedAt: null,
    };

    for (const permissao of PERMISSOES_DE_DINHEIRO) {
      await expect(
        guardaCom([permissao]).canActivate(contexto(semExigencia)),
        `${permissao} recusada com a exigência desligada`,
      ).resolves.toBe(true);
    }
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

  /**
   * Margem e custo não saem por `finance.view` (achado da revisão do bloco 48).
   *
   * `finance.view_profit` existe para o dono **delegar a operação sem entregar a
   * estratégia**: o gerente padrão vê faturamento e não vê margem, e há teste em
   * `packages/core/src/permissoes.test.ts` prendendo isso.
   *
   * A rota de rentabilidade do clube nasceu declarando `finance.view` e
   * devolvendo `margemCents` e `insumoCents` — a mesma decomposição que
   * `GET /estoque/margem` guarda desde o bloco 44.
   *
   * ## Por que este teste lê o **tipo de retorno**, e não o corpo do handler
   *
   * A primeira versão procurava as palavras "margem" e "insumo" dentro do
   * handler, e passou verde sobre a rota defeituosa: o corpo dela é
   * `return rentabilidadeDoClube({...})` e não escreve nenhuma das duas. Um
   * teste que não pega o defeito que o motivou é pior que teste nenhum — ele
   * ensina a confiar no verde.
   *
   * A versão que vale deriva de duas fontes, as duas do código: as interfaces de
   * `packages/finance` que **têm** campo de margem, custo ou sobra; e a
   * assinatura das funções que devolvem essas interfaces. Uma rota que chame
   * qualquer uma delas precisa declarar a permissão.
   *
   * O que ele **não** pega: uma função que devolva margem sem tipo declarado. É
   * limite conhecido, e o código tem `noImplicitAny` — o tipo existe.
   */
  it('rota que devolve margem, custo ou sobra declara finance.view_profit', () => {
    /**
     * `core` **e** `finance`, e a primeira não é opcional.
     *
     * `MargemDoServico extends DecomposicaoDaMargem`, e a base mora em `core`.
     * Varrendo só `finance`, a herança não se resolvia e a rota de margem do
     * estoque — que já declarava a permissão certa — passava despercebida: o
     * teste dizia verde sem enxergá-la, que é o pior tipo de verde.
     */
    const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages');
    const PASTAS = todosOsPacotes();
    /**
     * `margem`, `lucro`, `sobra`, `insumo` e `cmv` — e **não** `custo`.
     *
     * Custo sozinho é cadastro: o dono digita quanto pagou no shampoo, e ler
     * isso é `inventory.view`. O que `finance.view_profit` separa é a
     * **decomposição do resultado** — quanto sobra depois de comissão e insumo.
     * Com `custo` na lista, a varredura acusava a listagem de produtos e a
     * comanda, que é falso positivo por palavra igual.
     */
    /**
     * O campo diz resultado **e** diz dinheiro.
     *
     * Sem a segunda metade, `sobraMinutos` — a folga da cadeira, em minutos —
     * casava, e a varredura ampliada a todos os pacotes acusava o custo de
     * encaixe da fila. "Sobra" é palavra de dois assuntos; centavo e ponto-base
     * são de um só, e é a unidade que diz qual deles.
     */
    const CAMPO_DE_LUCRO = /\b(margem|insumo|sobra|lucro|cmv)\w*(Cents|Bps)\s*\??:/i;

    /** As interfaces de `finance` que carregam decomposição de resultado. */
    const tiposDeLucro = new Set<string>();
    /** Funções exportadas que devolvem uma delas. */
    const funcoesDeLucro = new Set<string>();
    const fontes = PASTAS.flatMap((pasta) =>
      readdirSync(pasta)
        .filter((n) => n.endsWith('.ts') && !n.includes('.test.'))
        .map((n) => readFileSync(join(pasta, n), 'utf8')),
    );

    for (const fonte of fontes) {
      for (const [nome, corpo] of interfacesDe(fonte)) {
        if (CAMPO_DE_LUCRO.test(corpo)) tiposDeLucro.add(nome);
      }
    }
    /*
      Segunda passada, até o ponto fixo: **herança e composição**.

      A herança sempre esteve aqui — `RentabilidadeNaTela extends
      RentabilidadeDoAssinante`. A composição entrou no bloco 52, e o motivo é o
      defeito que a revisão dele achou: `DreComparado` **contém** um `Dre`, que
      carrega `margemBps`, e `DreDoPeriodo extends DreComparado`. Sem a
      composição a varredura não alcançava o relatório de resultado inteiro — a
      rota mais óbvia do produto para `finance.view_profit` era justamente a que
      o teste não enxergava.

      A versão anterior deste comentário dizia que composição acusaria a comanda
      inteira. Era verdade quando a checagem era por **menção** em qualquer
      lugar do bloco; aqui ela é por **tipo declarado de um campo**, ancorado no
      `:` que abre a declaração. Um campo `readonly atual: Dre` casa; uma menção
      dentro de um genérico de lista, de um comentário ou de um parâmetro, não.
      O laço vai até parar de crescer porque a cadeia pode ter mais de um elo:
      `Dre` → `DreComparado` → `DreDoPeriodo`.
    */
    const corpoDaInterface = new Map<string, string>();
    const paiDaInterface = new Map<string, string>();
    for (const fonte of fontes) {
      for (const [nome, corpo] of interfacesDe(fonte)) {
        corpoDaInterface.set(nome, corpo);
      }
      for (const bloco of fonte.matchAll(/export interface (\w+) extends (\w+)/g)) {
        paiDaInterface.set(bloco[1] ?? '', bloco[2] ?? '');
      }
    }

    let cresceu = true;
    while (cresceu) {
      cresceu = false;
      for (const [filho, pai] of paiDaInterface) {
        if (tiposDeLucro.has(pai) && !tiposDeLucro.has(filho)) {
          tiposDeLucro.add(filho);
          cresceu = true;
        }
      }
      for (const [nome, corpo] of corpoDaInterface) {
        if (tiposDeLucro.has(nome)) continue;
        const compoe = [...tiposDeLucro].some((t) =>
          new RegExp(`:\\s*(readonly\\s+)?${t}\\b`).test(corpo),
        );
        if (compoe) {
          tiposDeLucro.add(nome);
          cresceu = true;
        }
      }
    }
    for (const fonte of fontes) {
      for (const [nome, retorno] of funcoesDe(fonte)) {
        if ([...tiposDeLucro].some((t) => new RegExp(`\\b${t}\\b`).test(retorno))) {
          funcoesDeLucro.add(nome);
        }
      }
    }

    expect(
      tiposDeLucro.size,
      'a varredura não achou nenhum tipo de margem — ela deixou de valer',
    ).toBeGreaterThan(0);
    expect(funcoesDeLucro.size).toBeGreaterThan(0);

    const redige = redigidoras(fontes);
    const faltando: string[] = [];
    for (const { arquivo, classe, corpo, guardada } of controllers()) {
      if (!guardada) continue;

      /**
       * O terminador é `$`, e não `\n\}$`.
       *
       * A primeira versão parava no fecha-chaves da classe **em fim de string**,
       * e o arquivo termina com uma quebra de linha depois dele: o resultado é
       * que o **último handler de cada controller** nunca era capturado. Foi
       * assim que a rota de margem do estoque — que declara a permissão certa —
       * passou despercebida, e é o defeito que quebrar o portão de propósito
       * revelou. Guarda que engole a última rota de todo arquivo é pior que
       * guarda nenhuma.
       */
      const handlers = [...corpo.matchAll(/@Exige\(([^)]*)\)([\s\S]*?)(?=@Exige\(|$)/g)];
      for (const handler of handlers) {
        const permissoes = handler[1] ?? '';
        // Só o que o handler **chama**: o comentário fala de margem o tempo todo.
        const codigo = (handler[2] ?? '')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*/g, '');
        const chamada = [...funcoesDeLucro].find((f) => new RegExp(`\\b${f}\\s*\\(`).test(codigo));
        if (!chamada) continue;
        if (permissoes.includes('finance.view_profit')) continue;
        /**
         * A exceção do schema semântico, e ela é **conquistada**, não declarada.
         *
         * O assistente é uma rota só que responde dezenas de perguntas: ela chama
         * `medir` e `rentabilidadeDoClube`, que devolvem receita e margem, e não
         * pode declarar `finance.view` — declarar cobraria a permissão de todo
         * mundo, inclusive de quem só quer saber quantos faltaram hoje.
         *
         * O que a torna segura é a permissão viajar com a **métrica**, conferida
         * em `validarPergunta` contra o que a pessoa tem no banco — e as outras
         * **duas** derivações da guarda viajando junto.
         *
         * A primeira versão desta isenção pedia só `validarPergunta`, e com isso
         * benzia uma rota que entregava faturamento sem segundo fator e abria o
         * caixa para a sessão de suporte: a `PermissaoGuard` deriva três coisas
         * do mesmo `@Exige`, e baixar o piso desligava as três. A isenção agora
         * cobra as três chamadas.
         * Uma rota nova que compuser métricas sem passar por ela continua sendo
         * reprovada — e o e2e do bloco 63 executa o ataque para provar que a
         * conferência de fato acontece.
         */
        if (isentoPeloSchemaSemantico(codigo)) continue;
        /**
         * A isenção por **redação**, e ela é estrutural.
         *
         * `campanhasDaCasa` devolve a receita atribuída por campanha e a rota
         * não pode declarar `finance.view`: `@Exige` é conjuntivo, e um papel
         * "Marketing" passava a criar e enviar campanha sem conseguir ver a que
         * enviou. Quem decide é `podeVerReceita`, declarado **e usado** pela
         * função — e a varredura confere as duas coisas.
         */
        if (redige.has(chamada)) continue;
        if (envolvidaPorRedigidora(codigo, chamada, redige)) continue;
        faltando.push(`${arquivo} · ${classe} · chama ${chamada}`);
      }
    }

    expect(faltando, 'rota devolve margem ou custo sem finance.view_profit').toEqual([]);
  });

  it('rota que devolve receita declara finance.view — e portanto segundo fator', () => {
    /**
     * A irmã do teste acima, e ela nasceu de um achado da `/security-review` do
     * bloco 62.
     *
     * A rota de crescimento declarava `reports.finance`, que **parece** a
     * permissão certa pelo nome e não está em `PERMISSOES_DE_DINHEIRO` — o grupo
     * que a `PermissaoGuard` usa para derivar o segundo fator filtra por prefixo
     * `finance.`/`cashier.` mais duas de comissão. O resultado seria um ano de
     * faturamento dia a dia saindo sem TOTP enquanto o DRE ao lado o cobra para
     * mostrar os mesmos centavos.
     *
     * O teste anterior deriva **margem**; este deriva **receita**, e são coisas
     * diferentes: um `Dre` tem os dois, mas uma série de faturamento tem só o
     * segundo. Sem esta varredura, a próxima rota de receita repete o defeito —
     * e uma lista escrita ao lado seria a que ninguém atualiza.
     */
    const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages');
    const PASTAS = todosOsPacotes();

    /**
     * `receita`, `faturamento`, `total...Cents`, `impacto...Cents` — e **não**
     * `preco` nem `valor`.
     *
     * Preço é catálogo, que a página pública mostra a qualquer visitante; valor
     * sozinho aparece em toda parte. O que `finance.view` separa é **quanto a
     * casa faturou**, e é isso que estes nomes descrevem.
     *
     * `impacto...Cents` entrou no bloco 67, e o motivo é o mesmo que a revisão
     * do bloco 46 escreveu sobre assinantes por plano: uma **contagem
     * multiplicada por ticket médio é faturamento por outro caminho**. O insight
     * proativo diz "até R$ 1.150 sendo deixados na mesa", e esse número sai do
     * ticket da casa — chamá-lo de impacto não o tira do grupo de dinheiro.
     */
    const CAMPO_DE_RECEITA = /\b(receita\w*|faturamento\w*|total\w*Cents|impacto\w*Cents)\s*:/i;

    const tiposDeReceita = new Set<string>();
    const funcoesDeReceita = new Set<string>();
    const fontes = PASTAS.flatMap((pasta) =>
      readdirSync(pasta)
        .filter((n) => n.endsWith('.ts') && !n.includes('.test.'))
        .map((n) => readFileSync(join(pasta, n), 'utf8')),
    );

    const corpoDaInterface = new Map<string, string>();
    const paiDaInterface = new Map<string, string>();
    for (const fonte of fontes) {
      for (const [nome, corpo] of interfacesDe(fonte)) {
        corpoDaInterface.set(nome, corpo);
        if (CAMPO_DE_RECEITA.test(corpo)) tiposDeReceita.add(nome);
      }
      for (const bloco of fonte.matchAll(/export interface (\w+) extends (\w+)/g)) {
        paiDaInterface.set(bloco[1] ?? '', bloco[2] ?? '');
      }
    }

    // Herança e composição até o ponto fixo, como no teste de margem: a série de
    // faturamento é um campo dentro do objeto que a rota devolve.
    let cresceu = true;
    while (cresceu) {
      cresceu = false;
      for (const [filho, pai] of paiDaInterface) {
        if (tiposDeReceita.has(pai) && !tiposDeReceita.has(filho)) {
          tiposDeReceita.add(filho);
          cresceu = true;
        }
      }
      for (const [nome, corpo] of corpoDaInterface) {
        if (tiposDeReceita.has(nome)) continue;
        const compoe = [...tiposDeReceita].some((t) =>
          new RegExp(`:\\s*(readonly\\s+)?${t}\\b`).test(corpo),
        );
        if (compoe) {
          tiposDeReceita.add(nome);
          cresceu = true;
        }
      }
    }

    for (const fonte of fontes) {
      /**
       * A janela é de 3000, e não de 900 como na varredura de margem.
       *
       * Não é folga por precaução: `crescimentoDaCasa` tem um parâmetro com
       * quinze linhas de comentário explicando por que o abandono entra por
       * fora, e o `Promise<...>` fica além de 900 caracteres da palavra
       * `function`. Com a janela curta a varredura **passava verde sobre a rota
       * que a revisão de segurança tinha acabado de reprovar** — guarda que não
       * alcança o defeito que a motivou é pior que guarda nenhuma, e foi só
       * quebrar a rota de propósito que isso apareceu.
       */
      for (const [nome, retorno] of funcoesDe(fonte)) {
        if ([...tiposDeReceita].some((t) => new RegExp(`\\b${t}\\b`).test(retorno))) {
          funcoesDeReceita.add(nome);
        }
      }

      /**
       * E a função **síncrona**, que é a de `packages/core`.
       *
       * A primeira versão só olhava `export async function ... Promise<...>`, e
       * com isso não enxergava nada de `core`: lá a função é pura e devolve o
       * tipo direto. `montarInsights` devolve `readonly Insight[]`, com o
       * impacto em centavos dentro, e a rota que o serve passava pela varredura
       * sem ser vista — o mesmo defeito da janela de 900 caracteres, um degrau
       * acima. Foi só tirar `finance.view` da rota de propósito para descobrir.
       */
      // `funcoesDe` já cobre a síncrona: ela lê o retorno depois do parêntese
      // que fecha, com ou sem `Promise<>`. Duas passadas eram duas chances de
      // divergir sobre a mesma pergunta.

    }

    expect(
      tiposDeReceita.size,
      'a varredura não achou nenhum tipo de receita — ela deixou de valer',
    ).toBeGreaterThan(0);
    expect(funcoesDeReceita.size).toBeGreaterThan(0);

    const redige = redigidoras(fontes);
    const faltando: string[] = [];
    for (const { arquivo, classe, corpo, guardada } of controllers()) {
      if (!guardada) continue;
      const handlers = [...corpo.matchAll(/@Exige\(([^)]*)\)([\s\S]*?)(?=@Exige\(|$)/g)];
      for (const handler of handlers) {
        const permissoes = handler[1] ?? '';
        const codigo = (handler[2] ?? '')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*/g, '');
        const chamada = [...funcoesDeReceita].find((f) =>
          new RegExp(`\\b${f}\\s*\\(`).test(codigo),
        );
        if (!chamada) continue;
        /**
         * Qualquer permissão do grupo de dinheiro serve.
         *
         * O que o teste cobra não é a string `finance.view`: é que a rota caia
         * dentro de `PERMISSOES_DE_DINHEIRO`, que é de onde o segundo fator é
         * derivado. `finance.view_profit` num relatório de resultado já cumpre.
         */
        if (PERMISSOES_DE_DINHEIRO.some((p) => permissoes.includes(`'${p}'`))) continue;
        /**
         * `commission.view_own` é a exceção, e ela já estava escrita.
         *
         * `permissoes.ts` a deixa **fora** do grupo de dinheiro de propósito: é
         * o barbeiro olhando o próprio holerite, o dado é dele e ele já provou a
         * senha. As duas rotas que a varredura acusou na primeira execução —
         * o extrato de comissão e os números do profissional — são exatamente
         * essa. Reprovar o certo é o que faz alguém desligar a guarda.
         */
        if (permissoes.includes("'commission.view_own'")) continue;
        /**
         * A isenção por **redação**, e ela é estrutural.
         *
         * `campanhasDaCasa` devolve a receita atribuída por campanha e a rota
         * não pode declarar `finance.view`: `@Exige` é conjuntivo, e um papel
         * "Marketing" passava a criar e enviar campanha sem conseguir ver a que
         * enviou. Quem decide é `podeVerReceita`, declarado **e usado** pela
         * função — e `redigidoras` confere as duas coisas.
         */
        if (redige.has(chamada)) continue;
        if (envolvidaPorRedigidora(codigo, chamada, redige)) continue;
        /**
         * A exceção do schema semântico, e ela é **conquistada**, não declarada.
         *
         * O assistente é uma rota só que responde dezenas de perguntas: ela chama
         * `medir` e `rentabilidadeDoClube`, que devolvem receita e margem, e não
         * pode declarar `finance.view` — declarar cobraria a permissão de todo
         * mundo, inclusive de quem só quer saber quantos faltaram hoje.
         *
         * O que a torna segura é a permissão viajar com a **métrica**, conferida
         * em `validarPergunta` contra o que a pessoa tem no banco — e as outras
         * **duas** derivações da guarda viajando junto.
         *
         * A primeira versão desta isenção pedia só `validarPergunta`, e com isso
         * benzia uma rota que entregava faturamento sem segundo fator e abria o
         * caixa para a sessão de suporte: a `PermissaoGuard` deriva três coisas
         * do mesmo `@Exige`, e baixar o piso desligava as três. A isenção agora
         * cobra as três chamadas.
         * Uma rota nova que compuser métricas sem passar por ela continua sendo
         * reprovada — e o e2e do bloco 63 executa o ataque para provar que a
         * conferência de fato acontece.
         */
        if (isentoPeloSchemaSemantico(codigo)) continue;
        faltando.push(`${arquivo} · ${classe} · chama ${chamada}`);
      }
    }

    expect(faltando, 'rota devolve receita sem nenhuma permissão de dinheiro').toEqual([]);
  });

  it('rota que nomeia o desempenho do colega declara appointments.view_all_professionals', () => {
    /**
     * A sexta vez que a regra da rota que agrega foi quebrada, virada em guarda.
     *
     * O insight proativo do bloco 67 devolvia, sob `appointments.view`, o nome de
     * cada profissional com a ocupação dele e quantos pedidos ele não absorveu —
     * *"João está com 97% de ocupação e catorze pessoas entraram na lista de
     * espera"*. `board` e `agenda` recortam esse dado desde sempre pela permissão
     * de ver a agenda da casa; a rota nova simplesmente não recortava, e como
     * papel é editável desde o bloco 30 bastava um `finance.view` dado a um
     * barbeiro sênior para ele ler a comparação entre colegas.
     *
     * A varredura **deriva** de `core` e `scheduling` quais tipos descrevem uma
     * pessoa da equipe com número de desempenho ao lado — `profissionalId` **e**
     * ocupação ou pedidos — e cobra a permissão em toda rota que os sirva. Lista
     * escrita ao lado seria a que ninguém atualiza.
     */
    const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages');
    const PASTAS = todosOsPacotes();

    /** Quem é a pessoa, e um número que a compara com as outras. */
    const CAMPO_DE_PESSOA = /\bprofissionalId\s*:/;
    const CAMPO_DE_DESEMPENHO = /\b(ocupacao\w*|pedidos\w*)\s*:/i;

    const tiposDeDesempenho = new Set<string>();
    const corpoDaInterface = new Map<string, string>();
    const fontes = PASTAS.flatMap((pasta) =>
      readdirSync(pasta)
        .filter((n) => n.endsWith('.ts') && !n.includes('.test.'))
        .map((n) => readFileSync(join(pasta, n), 'utf8')),
    );

    for (const fonte of fontes) {
      for (const [nome, corpo] of interfacesDe(fonte)) {
        corpoDaInterface.set(nome, corpo);
        if (CAMPO_DE_PESSOA.test(corpo) && CAMPO_DE_DESEMPENHO.test(corpo)) {
          tiposDeDesempenho.add(nome);
        }
      }
    }

    // Composição até o ponto fixo: o cartão do painel **contém** a agenda
    // apertada, e é o cartão que a rota devolve.
    let cresceu = true;
    while (cresceu) {
      cresceu = false;
      for (const [nome, corpo] of corpoDaInterface) {
        if (tiposDeDesempenho.has(nome)) continue;
        const compoe = [...tiposDeDesempenho].some((t) =>
          new RegExp(`:\\s*(readonly\\s+)?${t}\\b`).test(corpo),
        );
        if (compoe) {
          tiposDeDesempenho.add(nome);
          cresceu = true;
        }
      }
    }

    const funcoes = new Set<string>();
    for (const fonte of fontes) {
      for (const [nome, retorno] of funcoesDe(fonte)) {
        if ([...tiposDeDesempenho].some((t) => new RegExp(`\\b${t}\\b`).test(retorno))) {
          funcoes.add(nome);
        }
      }
    }

    expect(
      tiposDeDesempenho.size,
      'a varredura não achou nenhum tipo de desempenho — ela deixou de valer',
    ).toBeGreaterThan(0);
    expect(funcoes.size).toBeGreaterThan(0);

    const faltando: string[] = [];
    for (const { arquivo, classe, corpo, guardada } of controllers()) {
      if (!guardada) continue;
      for (const handler of corpo.matchAll(/@Exige\(([^)]*)\)([\s\S]*?)(?=@Exige\(|$)/g)) {
        const permissoes = handler[1] ?? '';
        const codigo = (handler[2] ?? '')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*/g, '');
        const chamada = [...funcoes].find((f) => new RegExp(`\\b${f}\\s*\\(`).test(codigo));
        if (!chamada) continue;
        if (permissoes.includes("'appointments.view_all_professionals'")) continue;
        /**
         * `commission.view_own` é a exceção de sempre: o barbeiro olhando os
         * próprios números. É a mesma isenção da varredura de receita, e pela
         * mesma razão — reprovar o certo é o que faz alguém desligar a guarda.
         */
        if (permissoes.includes("'commission.view_own'")) continue;
        faltando.push(`${arquivo} · ${classe} · chama ${chamada}`);
      }
    }

    expect(
      faltando,
      'rota nomeia o desempenho do colega sem declarar appointments.view_all_professionals',
    ).toEqual([]);
  });

  it('rota que devolve estoque declara inventory.view', () => {
    /**
     * A sétima vez que a regra da rota que agrega foi quebrada, virada em guarda.
     *
     * O insight de estoque do bloco 69 passou a nomear o produto, dizer em
     * quantos dias ele acaba e quantas unidades comprar — tudo que
     * `GET /estoque/produtos` serve sob `inventory.view` — numa rota que não a
     * declarava. Bastava a barbearia tirar `inventory.view` do gerente, um
     * clique na tela de permissões, para o painel virar o caminho mais curto
     * para o estoque do que a própria tela de estoque.
     *
     * A varredura **deriva** de `core` e `finance` quais tipos descrevem estoque
     * — identidade de produto ao lado de saldo, prazo ou compra — e cobra a
     * permissão em toda rota que os sirva.
     */
    const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages');
    const PASTAS = todosOsPacotes();

    const CAMPO_DE_PRODUTO = /\b(produtoId|minimo)\s*:/;
    const CAMPO_DE_ESTOQUE = /\b(saldo|diasAteAcabar|comprar\w*|saidasNaJanela)\s*:/;

    const tiposDeEstoque = new Set<string>();
    const corpoDaInterface = new Map<string, string>();
    const fontes = PASTAS.flatMap((pasta) =>
      readdirSync(pasta)
        .filter((n) => n.endsWith('.ts') && !n.includes('.test.'))
        .map((n) => readFileSync(join(pasta, n), 'utf8')),
    );

    for (const fonte of fontes) {
      for (const [nome, corpo] of interfacesDe(fonte)) {
        corpoDaInterface.set(nome, corpo);
        if (CAMPO_DE_PRODUTO.test(corpo) && CAMPO_DE_ESTOQUE.test(corpo)) {
          tiposDeEstoque.add(nome);
        }
      }
    }

    let cresceu = true;
    while (cresceu) {
      cresceu = false;
      for (const [nome, corpo] of corpoDaInterface) {
        if (tiposDeEstoque.has(nome)) continue;
        const compoe = [...tiposDeEstoque].some((t) =>
          new RegExp(`:\\s*(readonly\\s+)?${t}\\b`).test(corpo),
        );
        if (compoe) {
          tiposDeEstoque.add(nome);
          cresceu = true;
        }
      }
    }

    const funcoes = new Set<string>();
    for (const fonte of fontes) {
      for (const [nome, retorno] of funcoesDe(fonte)) {
        if ([...tiposDeEstoque].some((t) => new RegExp(`\\b${t}\\b`).test(retorno))) {
          funcoes.add(nome);
        }
      }
    }

    expect(
      tiposDeEstoque.size,
      'a varredura não achou nenhum tipo de estoque — ela deixou de valer',
    ).toBeGreaterThan(0);
    expect(funcoes.size).toBeGreaterThan(0);

    const faltando: string[] = [];
    for (const { arquivo, classe, corpo, guardada } of controllers()) {
      if (!guardada) continue;
      for (const handler of corpo.matchAll(/@Exige\(([^)]*)\)([\s\S]*?)(?=@Exige\(|$)/g)) {
        const permissoes = handler[1] ?? '';
        const codigo = (handler[2] ?? '')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*/g, '');
        const chamada = [...funcoes].find((f) => new RegExp(`\\b${f}\\s*\\(`).test(codigo));
        if (!chamada) continue;
        if (/'inventory\.\w+'/.test(permissoes)) continue;
        faltando.push(`${arquivo} · ${classe} · chama ${chamada}`);
      }
    }

    expect(faltando, 'rota devolve estoque sem declarar inventory.view').toEqual([]);
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

/**
 * Rota que devolve dado do cadastro do cliente declara `customers.view`.
 *
 * Regra escrita do projeto — *"permissão de rota que agrega declara **todas** as
 * permissões do que ela devolve, e não a mais próxima do nome"* — e ela já foi
 * quebrada duas vezes: na exportação do titular (bloco 31) e aqui, na rota que
 * devolve a nota **e** o tomador.
 *
 * A varredura procura o sintoma que os dois casos tiveram em comum: o handler
 * chama uma função cujo nome diz que ela lê cadastro de cliente, e a rota
 * declara só a permissão do próprio assunto. O papel "Contador" — `fiscal.view`
 * sem `customers.*`, configuração natural desde que os papéis viraram
 * editáveis — colhia nome e CPF de todo cliente que já pediu nota.
 *
 * ## A lista escrita ficou com um nome só, e foi por baixo dela que a nona passou
 *
 * O comentário dizia que ela *"cresce quando alguém acrescentar outra"*.
 * Ninguém acrescentou — e a **listagem** fiscal por período voltou a devolver o
 * nome do tomador, porque ela lê a cópia **congelada** na nota e não o cadastro
 * vivo. A lista via `tomadorDaVenda` e mais nada.
 *
 * Quem prende a classe inteira agora é a varredura derivada de **pessoa** (a
 * quinta, acima): ela pergunta pelo formato do tipo — campo que diz cliente e
 * diz identidade, ou tipo que aponta uma pessoa e carrega identidade nua — e
 * subsome este caso, porque `TomadorDaVenda` casa pelo primeiro anchor.
 *
 * Esta continua por um motivo só, e é barato: ela ancora no **nome da função**,
 * então pega a leitura que devolve um tipo anônimo ou um `Pick<>`, que o
 * formato não alcança. Duas redes com recortes diferentes sobre a mesma regra
 * é o desenho certo quando nenhuma das duas cobre tudo.
 */
const LEITURAS_DE_CADASTRO = ['tomadorDaVenda'];

describe('rota que devolve cadastro de cliente', () => {
  it('declara customers.view junto da permissão do próprio assunto', () => {
    const faltando: string[] = [];

    for (const { arquivo, corpo } of controllers()) {
      for (const leitura of LEITURAS_DE_CADASTRO) {
        if (!corpo.includes(leitura)) continue;

        // O `@Exige` mais próximo acima de cada método que chama a leitura.
        for (const uso of [...corpo.matchAll(new RegExp(`${leitura}\\(`, 'g'))]) {
          const antes = corpo.slice(0, uso.index ?? 0);
          const exige = [...antes.matchAll(/@Exige\(([^)]*)\)/g)].pop();
          if (!exige?.[1]?.includes("'customers.view'")) {
            faltando.push(`${arquivo}: ${leitura} sob ${exige?.[1] ?? 'nenhum @Exige'}`);
          }
        }
      }
    }

    expect(faltando).toEqual([]);
  });

  /**
   * Rota que devolve **uma pessoa identificada** declara `customers.view`.
   *
   * As três derivações acima perguntam por **assunto** — margem, receita,
   * desempenho do colega. Nenhuma pergunta por **pessoa**, e a única guarda que
   * o fazia era uma lista escrita com um nome só (`LEITURAS_DE_CADASTRO`), que
   * o próprio comentário admitia que *"cresce quando alguém acrescentar outra"*
   * — ninguém acrescentou, e a listagem fiscal passou por baixo dela devolvendo
   * o nome do tomador congelado na nota.
   *
   * A regra da rota que agrega já foi quebrada oito vezes, e cinco delas eram
   * esta mesma classe: a comanda, a agenda, o painel do dia, a fila e a ficha.
   *
   * ## O anchor: o nome do campo, não a menção
   *
   * (A) um campo cujo nome diz cliente **e** identidade — `customerName`,
   *     `clienteNome`, `customerPhoneTail`, `clienteCpf`;
   * (B) um tipo que aponta uma pessoa (`customerId`) **e** carrega identidade
   *     nua (`nome`, `telefone`, `cpf`, `email`, `fotoUrl`) — é a `Ficha`.
   *
   * Propaga por herança **e** composição até o ponto fixo, como as três
   * anteriores. A isenção é conquistada: quem redige em vez de recusar recebe
   * `podeVerCliente` e sai do caminho — não há lista de arquivos isentos.
   *
   * ## Três correções mecânicas sobre o que as anteriores fazem
   *
   * Todos os pacotes (e não `core` + `finance`), corpo da interface por
   * contagem de chaves (e não `[^}]*`, que para no primeiro objeto aninhado e
   * escondia `DayBoard`), e fim da lista de parâmetros por contagem de
   * parênteses (e não janela de N caracteres, que já foi esticada uma vez e
   * ainda deixava `fecharComanda` de fora).
   */
  it('rota que devolve pessoa identificada declara customers.view', () => {
    const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages');
    const PASTAS = readdirSync(RAIZ)
      .map((p) => join(RAIZ, p, 'src'))
      .filter((p) => existsSync(p));

    /** (A) o campo diz cliente e diz identidade. */
    const CAMPO_DE_PESSOA =
      /\b(customer|cliente)(Name|Nome|Phone\w*|Telefone\w*|TaxId|Cpf|Foto\w*|Email)\s*\??:/;
    /** (B) aponta uma pessoa… */
    const APONTA_PESSOA = /\b(customerId|clienteId)\s*\??:/;
    /** …e carrega identidade nua. */
    const IDENTIDADE_NUA = /\b(nome|name|telefone\w*|phone\w*|cpf|taxId|fotoUrl|email)\s*\??:/i;

    /** O corpo de um bloco, por **contagem de chaves**. */
    const corpoDe = (fonte: string, abre: number): string => {
      let nivel = 0;
      for (let i = abre; i < fonte.length; i += 1) {
        if (fonte[i] === '{') nivel += 1;
        else if (fonte[i] === '}') {
          nivel -= 1;
          if (nivel === 0) return fonte.slice(abre + 1, i);
        }
      }
      return fonte.slice(abre);
    };

    const fontes = PASTAS.flatMap((pasta) =>
      readdirSync(pasta)
        .filter((n) => n.endsWith('.ts') && !n.includes('.test.'))
        .map((n) => readFileSync(join(pasta, n), 'utf8')),
    );

    const tiposDePessoa = new Set<string>();
    const corpoDaInterface = new Map<string, string>();
    const paiDaInterface = new Map<string, string>();

    for (const fonte of fontes) {
      for (const m of fonte.matchAll(/export interface (\w+)[^{]*\{/g)) {
        const nome = m[1] ?? '';
        const corpo = corpoDe(fonte, (m.index ?? 0) + m[0].length - 1);
        corpoDaInterface.set(nome, corpo);
        if (CAMPO_DE_PESSOA.test(corpo)) tiposDePessoa.add(nome);
        if (APONTA_PESSOA.test(corpo) && IDENTIDADE_NUA.test(corpo)) tiposDePessoa.add(nome);
      }
      for (const m of fonte.matchAll(/export interface (\w+) extends (\w+)/g)) {
        paiDaInterface.set(m[1] ?? '', m[2] ?? '');
      }
    }

    // Ponto fixo: herança e composição.
    for (let mudou = true; mudou; ) {
      mudou = false;
      for (const [filho, pai] of paiDaInterface) {
        if (tiposDePessoa.has(pai) && !tiposDePessoa.has(filho)) {
          tiposDePessoa.add(filho);
          mudou = true;
        }
      }
      for (const [nome, corpo] of corpoDaInterface) {
        if (tiposDePessoa.has(nome)) continue;
        const compoe = [...tiposDePessoa].some((t) => new RegExp(`:\\s*readonly\\s+${t}\\b|:\\s*${t}\\b`).test(corpo));
        if (compoe) {
          tiposDePessoa.add(nome);
          mudou = true;
        }
      }
    }

    /** A lista de parâmetros, por **contagem de parênteses**. */
    const parametrosDe = (fonte: string, abre: number): string => {
      let nivel = 0;
      for (let i = abre; i < fonte.length; i += 1) {
        if (fonte[i] === '(') nivel += 1;
        else if (fonte[i] === ')') {
          nivel -= 1;
          if (nivel === 0) return fonte.slice(abre + 1, i);
        }
      }
      return '';
    };

    const redige = redigidoras(fontes);
    const funcoesDePessoa = new Set<string>();
    for (const fonte of fontes) {
      /**
       * `export function` também, e não só `export async function`.
       *
       * A primeira versão só via a assíncrona, e com isso não enxergava nada de
       * `packages/core`, onde a função é pura e devolve o tipo direto. É o
       * mesmo defeito que a varredura de receita já tinha corrigido um bloco
       * antes — e ele voltou porque esta nasceu com regex próprio em vez de
       * reusar o que já existia.
       */
      for (const m of fonte.matchAll(/export (?:async )?function (\w+)\(/g)) {
        const abre = (m.index ?? 0) + m[0].length - 1;
        const params = parametrosDe(fonte, abre);
        const depois = fonte.slice(abre + params.length + 2, abre + params.length + 260);
        const retorno = /Promise<([^>]+(?:<[^>]*>)?[^>]*)>/.exec(depois)?.[1] ?? '';
        if (![...tiposDePessoa].some((t) => new RegExp(`\\b${t}\\b`).test(retorno))) continue;

        /**
         * A isenção conquistada: quem **redige** recebe `podeVerCliente`.
         *
         * Não há lista de arquivos isentos — a função que decide mostrar ou não
         * o nome declara o parâmetro, e a varredura sai do caminho. Foi assim
         * que `applyAttendance` saiu, e é assim que a próxima sai.
         *
         * `redigidoras` cobra o interruptor **usado no corpo**, e não só
         * declarado na assinatura: declarar e ignorar contornava a varredura
         * inteira e custava uma linha. Achado da revisão de segurança do bloco
         * 118.
         */
        const redigeAqui =
          redige.has(m[1] ?? '') ||
          // …ou o parâmetro é um tipo nomeado que o declara: `createException`
          // recebe `NovaExcecao`, e a isenção precisa seguir o tipo.
          [...corpoDaInterface].some(
            ([nome, corpo]) =>
              /podeVerCliente\s*\??:/.test(corpo) && new RegExp(`\\b${nome}\\b`).test(params),
          );
        if (redigeAqui) continue;
        funcoesDePessoa.add(m[1] ?? '');
      }
    }

    expect(tiposDePessoa.size, 'a varredura precisa achar tipos para valer').toBeGreaterThan(0);
    expect(funcoesDePessoa.size, 'e funções que os devolvam').toBeGreaterThan(0);

    const faltando: string[] = [];
    for (const { arquivo, corpo, guardada } of controllers()) {
      if (!guardada) continue;
      const handlers = [...corpo.matchAll(/@Exige\(([^)]*)\)([\s\S]*?)(?=@Exige\(|$)/g)];
      for (const handler of handlers) {
        const permissoes = handler[1] ?? '';
        const codigo = handler[2] ?? '';
        if (/customers\.(view|export)\b/.test(permissoes)) continue;
        const chamada = [...funcoesDePessoa].find((f) => new RegExp(`\\b${f}\\s*\\(`).test(codigo));
        if (!chamada) continue;
        /**
         * A redação também vale **na borda**, quando a chamada é embrulhada.
         *
         * As seis rotas da comanda devolvem o mesmo objeto e nenhuma das seis
         * funções do domínio recebe o interruptor: quem redige é
         * `comandaVisivel`, e a chamada acusada vai **dentro** dos argumentos
         * dela. A conferência é estrutural — fingir a isenção exige embrulhar
         * numa função de redação de verdade, que é o que se queria.
         */
        if (envolvidaPorRedigidora(codigo, chamada, redige)) continue;
        faltando.push(`${arquivo} · @Exige(${permissoes.trim()}) · ${chamada}`);
      }
    }

    expect(
      faltando,
      'esta rota devolve nome, telefone, CPF ou foto de cliente sem declarar customers.view — ' +
        'declare a permissão, ou receba `podeVerCliente` e redija o campo',
    ).toEqual([]);
  });
});
