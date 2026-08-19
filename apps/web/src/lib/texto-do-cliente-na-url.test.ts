import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * O que o cliente escreve não vai para a URL (bloco 106).
 *
 * ## Por que aqui é diferente do assistente do gestor
 *
 * O assistente do painel põe a pergunta em `?p=`, e ali está certo — a tela é
 * `noindex`, fica atrás de sessão, e o texto é uma métrica ("faturamento de
 * agosto"). A conversa do cliente é outra coisa: página pública, texto livre, e
 * nada impede a frase de ser *"meu nome é Ana, meu telefone é tal, consigo
 * cortar amanhã?"*.
 *
 * Na URL essa frase fica no histórico do navegador — que num celular emprestado
 * é de outra pessoa —, no autocompletar da barra e em qualquer `Referer`. É o
 * precedente do código de erro que não nomeia o mecanismo do score, e o de
 * `guardarSenhaDeUmaVez`: o que não pode ir para a URL sai por cookie
 * `httpOnly` de vida curta.
 *
 * ## Por que ler o texto em vez de exercitar o handler
 *
 * O que precisa ficar preso não é o comportamento de uma chamada: é que
 * **nenhuma** versão futura deste caminho adquira o hábito — que é exatamente
 * como o convite do barbeiro mandou a senha em `?convidado=` no bloco 16.
 */

const ACOES = readFileSync(
  join(import.meta.dirname, '../app/[slug]/conversar/perguntar/route.ts'),
  'utf8',
);

/** Por instrução, não por linha: `new URLSearchParams({` e o campo são linhas diferentes. */
const SEM_COMENTARIO = ACOES.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const INSTRUCOES = SEM_COMENTARIO.split(';').map((p) => p.trim()).filter(Boolean);

describe('o texto que o cliente escreve na conversa', () => {
  it('a varredura encontra o arquivo que deveria vigiar', () => {
    expect(SEM_COMENTARIO).toContain('export async function POST');
    expect(INSTRUCOES.length).toBeGreaterThan(5);
  });

  it('nunca entra numa URL', () => {
    /**
     * A âncora é o texto **dentro** de uma construção de URL, não a menção
     * solta.
     *
     * A primeira versão reprovava `if (!texto) redirect(destino)` — que não põe
     * nada na URL, só decide se redireciona. Guarda que acusa o certo é guarda
     * que alguém desliga, e uma desligada não pega o errado.
     *
     * O que se procura: `texto` interpolado num literal de template (que é como
     * uma URL se escreve aqui) ou entregue a `URLSearchParams`.
     */
    const suspeitas = INSTRUCOES.filter((instrucao) => {
      const literais = instrucao.match(/`[^`]*`/g) ?? [];
      const buscas = instrucao.match(/URLSearchParams\([^)]*\)/g) ?? [];
      return [...literais, ...buscas].some((trecho) => /\btexto\b/.test(trecho));
    });
    expect(suspeitas, 'texto do cliente indo para a URL').toEqual([]);
  });

  it('sai por cookie httpOnly, strict, de caminho restrito e vida curta', () => {
    expect(SEM_COMENTARIO).toContain('httpOnly: true');
    expect(SEM_COMENTARIO).toContain("sameSite: 'strict'");
    // Nunca a raiz da barbearia: o cookie não acompanha a navegação pelo site.
    expect(SEM_COMENTARIO).toContain('path: destino');
    expect(SEM_COMENTARIO).toContain('maxAge: SEGUNDOS');
  });

  it('o redirecionamento é relativo, e não para a origem interna do servidor', () => {
    /**
     * `NextResponse.redirect` exige endereço absoluto e o monta a partir de
     * `requisicao.url` — que é a origem **interna**. No piloto isso saiu como
     * `http://localhost:3011` com o navegador em `http://127.0.0.1:3011`: hosts
     * diferentes, potes de cookie diferentes, e a tela mostrando o estado vazio
     * depois de uma resposta que existia.
     *
     * Em produção seria pior que um teste vermelho: atrás do Caddy, a origem
     * interna é um endereço que o cliente não alcança.
     */
    expect(SEM_COMENTARIO).not.toContain('NextResponse.redirect');
    expect(SEM_COMENTARIO).toContain('location: destino');
  });
});
