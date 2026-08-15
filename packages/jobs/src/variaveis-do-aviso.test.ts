import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TIPOS_DE_NOTIFICACAO, VARIAVEIS_DO_AVISO } from '@barbearia/core';

/**
 * A ordem das variáveis do worker é a que a tela promete — e ela não era.
 *
 * A Meta preenche `{{1}}`, `{{2}}`, `{{3}}` por **posição**. Isso faz da lista
 * que o worker monta e da lista que a tela de cadastro do texto exibe a mesma
 * informação dita em dois lugares, e o par divergiu do jeito mais caro
 * possível: a tela dizia que `{{2}}` era a hora e `{{3}}` o profissional, e o
 * worker mandava **nome do cliente e nome da barbearia**, dois valores, para
 * todo tipo de aviso.
 *
 * O que a barbearia recebia por escrever "seu corte é amanhã às {{2}}" era o
 * cliente lendo "seu corte é amanhã às Barbearia Matheus". Com `{{3}}`, a Meta
 * recusava o envio inteiro e ninguém recebia nada.
 *
 * Nenhuma suíte pegava: cada metade era coerente sozinha.
 *
 * A guarda lê o **fonte** do worker em vez de exercitar o envio porque o que se
 * quer proibir é ele voltar a montar a lista à mão. Exercitar provaria os
 * valores de hoje; isto proíbe a segunda fonte de verdade.
 */

/**
 * A guarda mora aqui, e não em `apps/worker`, porque é este pacote que define
 * `MensagemDeAgendamento` e o contrato do provedor — o worker é a única
 * implementação. E porque o worker não tem `vitest`, e ganhar uma dependência
 * só para hospedar um teste é o tipo de decisão que se toma sem perceber.
 */
const worker = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'worker', 'src', 'main.ts'),
  'utf8',
);

function semComentario(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('as variáveis do template', () => {
  it('o worker monta a lista a partir do mapa, e não à mão', () => {
    const codigo = semComentario(worker);

    expect(codigo).toContain('VARIAVEIS_DO_AVISO[params.tipo].map(');
    // A lista escrita à mão que existia antes, e que a tela contradizia.
    expect(codigo).not.toContain('[params.clienteNome, params.barbearia]');
  });

  it('todo tipo de aviso declara o que cada posição significa', () => {
    for (const tipo of TIPOS_DE_NOTIFICACAO) {
      const quais = VARIAVEIS_DO_AVISO[tipo];
      expect(quais.length, tipo).toBeGreaterThan(0);
      // Duas posições com o mesmo significado tornariam a ordem indiferente na
      // leitura e decisiva no envio, que é a pior combinação.
      expect(new Set(quais).size, tipo).toBe(quais.length);
    }
  });

  it('o worker sabe produzir todo significado que o mapa declara', () => {
    /**
     * O mapa de valores do worker é escrito à mão — é ele que liga "a hora do
     * agendamento" ao campo da mensagem. Um significado novo no `core` sem par
     * ali vira string vazia em silêncio: a mensagem sai com um buraco, e é a
     * classe de defeito do campo que o motor aceita e ninguém preenche.
     */
    const declarados = new Set(TIPOS_DE_NOTIFICACAO.flatMap((t) => [...VARIAVEIS_DO_AVISO[t]]));

    for (const qual of declarados) {
      expect(worker, qual).toContain(`'${qual}':`);
    }
  });
});
