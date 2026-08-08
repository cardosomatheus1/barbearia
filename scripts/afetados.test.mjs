import { describe, expect, it } from 'vitest';
import { afetadosPor, lerPacotes } from './afetados.mjs';

/**
 * O resolvedor que decide o que vai ser conferido.
 *
 * Se ele errar **para menos**, o modo rápido devolve verde sobre código que
 * ninguém rodou — pior do que não existir. Por isso a regra mais importante
 * aqui não é "acha o pacote certo", é "na dúvida, roda tudo".
 *
 * O grafo de mentira é declarado no teste de propósito: o de verdade muda a
 * cada bloco, e um teste amarrado a ele viraria manutenção sem prova nova. O
 * grafo real ganha um teste próprio, que confere o formato e não os nomes.
 */

const GRAFO = new Map([
  ['@barbearia/core', { dir: 'packages/core', temTeste: true, deps: [] }],
  ['@barbearia/db', { dir: 'packages/db', temTeste: true, deps: [] }],
  ['@barbearia/ui', { dir: 'packages/ui', temTeste: true, deps: [] }],
  [
    '@barbearia/identity',
    { dir: 'packages/identity', temTeste: true, deps: ['@barbearia/core', '@barbearia/db'] },
  ],
  [
    '@barbearia/finance',
    {
      dir: 'packages/finance',
      temTeste: true,
      deps: ['@barbearia/core', '@barbearia/db', '@barbearia/identity'],
    },
  ],
  // `api` depende **só** de `finance`, de propósito: assim `core` só a alcança
  // em dois saltos. Com um atalho direto para `core`, um fecho de primeiro
  // nível passaria neste teste e ele não provaria nada.
  ['@barbearia/api', { dir: 'apps/api', temTeste: true, deps: ['@barbearia/finance'] }],
  ['@barbearia/web', { dir: 'apps/web', temTeste: true, deps: ['@barbearia/core'] }],
  ['@barbearia/sem-teste', { dir: 'packages/sem-teste', temTeste: false, deps: [] }],
]);

const resolver = (arquivos) => afetadosPor(arquivos, GRAFO);

describe('o que precisa ser conferido', () => {
  it('mudar uma folha confere ela e quem depende dela', () => {
    const { todos, lista } = resolver(['packages/finance/src/comanda.ts']);
    expect(todos).toBe(false);
    expect(lista).toEqual(['@barbearia/api', '@barbearia/finance']);
  });

  it('mudar o core alcança a árvore inteira, não só quem o cita direto', () => {
    // `api` não cita `core`: chega nele por `finance`, em dois saltos. O fecho
    // tem que ser transitivo — parar no primeiro nível é como um atalho deixa
    // de conferir sem avisar.
    //
    // A primeira versão deste teste dava `core` como dependência direta de
    // `api` e passava mesmo com o fecho quebrado. Parecia prova e não era.
    const { lista } = resolver(['packages/core/src/comanda.ts']);
    expect(lista).toEqual([
      '@barbearia/api',
      '@barbearia/core',
      '@barbearia/finance',
      '@barbearia/identity',
      '@barbearia/web',
    ]);
  });

  it('mudança fora de pacote confere tudo', () => {
    // `scripts/`, `tsconfig.base.json`, a raiz: não dá para mapear com
    // honestidade, e errar para menos aqui devolve verde falso.
    const { todos, lista } = resolver(['tsconfig.base.json']);
    expect(todos).toBe(true);
    expect(lista).toContain('@barbearia/api');
    expect(lista).toContain('@barbearia/web');
  });

  it('um arquivo fora de pacote no meio de vários dentro ainda confere tudo', () => {
    // O caso que um `find` distraído erraria: achar o primeiro dono e parar.
    const { todos } = resolver([
      'packages/finance/src/comanda.ts',
      'scripts/verify.sh',
      'packages/core/src/zone.ts',
    ]);
    expect(todos).toBe(true);
  });

  it('nada mudou é lista vazia, não "tudo"', () => {
    expect(resolver([])).toEqual({ todos: false, lista: [] });
  });

  it('pacote sem script de teste não entra na lista', () => {
    // Ele existe no grafo para o fecho transitivo, mas mandar `pnpm test` nele
    // só produziria erro de script inexistente.
    const { lista } = resolver(['packages/sem-teste/src/x.ts']);
    expect(lista).toEqual([]);
  });

  it('prefixo parecido não confunde dono', () => {
    // `packages/core-legado/` não é `packages/core/`. Sem a barra no fim da
    // comparação, seria.
    const grafo = new Map([
      ['@barbearia/core', { dir: 'packages/core', temTeste: true, deps: [] }],
      ['@barbearia/core-legado', { dir: 'packages/core-legado', temTeste: true, deps: [] }],
    ]);
    const { lista } = afetadosPor(['packages/core-legado/src/x.ts'], grafo);
    expect(lista).toEqual(['@barbearia/core-legado']);
  });
});

describe('o grafo de verdade', () => {
  it('sai dos package.json e inclui os pacotes novos sozinho', () => {
    // O ponto de ler o grafo do disco: `packages/finance` nasceu no bloco 18 e
    // apareceu aqui sem ninguém acrescentar uma linha. Este teste falha no dia
    // em que alguém trocar isso por uma lista escrita à mão.
    const pacotes = lerPacotes();
    expect(pacotes.has('@barbearia/finance')).toBe(true);
    expect(pacotes.get('@barbearia/api')?.deps).toContain('@barbearia/finance');
    expect(pacotes.get('@barbearia/core')?.deps).toEqual([]);
  });

  it('mudar o core no grafo real alcança a api e o web', () => {
    const { lista } = afetadosPor(['packages/core/src/zone.ts']);
    expect(lista).toContain('@barbearia/api');
    expect(lista).toContain('@barbearia/web');
    expect(lista).toContain('@barbearia/finance');
  });
});
