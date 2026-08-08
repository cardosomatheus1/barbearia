import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Senha de primeiro acesso nunca vai pela URL.
 *
 * Esta regra existia escrita desde o bloco 12, em `sessao-gestor.ts`, e o
 * mecanismo que a cumpre — `guardarSenhaDeUmaVez`, cookie `httpOnly` de dois
 * minutos com caminho restrito — também. Não impediu o convite do barbeiro, no
 * bloco 16, de mandar a senha em `?convidado=...`. Quem pegou foi o
 * `/security-review`, não o portão.
 *
 * Regra escrita e não verificada é o defeito que este projeto já encontrou
 * sete vezes. Este teste lê o código e reprova se qualquer ação de servidor
 * puser `senhaInicial` numa `URLSearchParams`, num `redirect` ou num `falhar`.
 *
 * Por que ler o texto em vez de exercitar a função: a ação chama `redirect()`,
 * que no Next lança para o framework. Provar o destino exigiria montar o
 * roteador inteiro — e o que precisa ser garantido aqui não é o comportamento
 * de uma ação, é que **nenhuma** delas adquira o hábito.
 */

const ACOES = readFileSync(
  join(import.meta.dirname, '../app/admin/acoes.ts'),
  'utf8',
);

/**
 * Código sem comentário, partido por instrução.
 *
 * **Por instrução, não por linha** — e essa distinção não é detalhe. A primeira
 * versão deste teste conferia linha a linha e passou com a senha de volta na
 * URL: `const busca = new URLSearchParams({` e `convidado: senhaInicial,` são
 * linhas diferentes, então nenhuma continha as duas coisas. Um teste que só
 * pega o vazamento escrito numa linha só não pega vazamento nenhum.
 */
const SEM_COMENTARIO = ACOES.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const INSTRUCOES = SEM_COMENTARIO.split(';').map((parte) => parte.trim()).filter(Boolean);

const COM_SENHA = INSTRUCOES.filter((instrucao) => instrucao.includes('senhaInicial'));

describe('a senha de primeiro acesso', () => {
  it('o teste encontra os usos que deveria vigiar', () => {
    // Sem esta guarda, renomear `senhaInicial` deixaria os outros três testes
    // verdes sobre zero ocorrências — verde por não ter olhado.
    expect(COM_SENHA.length).toBeGreaterThanOrEqual(3);
  });

  it('só sai por guardarSenhaDeUmaVez', () => {
    /**
     * Toda instrução que toca a senha ou a guarda no cookie, ou a lê da
     * resposta da API para guardá-la. Qualquer outra forma de uso é caminho
     * novo — e caminho novo para credencial merece ser lido por gente antes de
     * entrar.
     */
    for (const instrucao of COM_SENHA) {
      expect(
        instrucao.includes('guardarSenhaDeUmaVez'),
        `uso não previsto de senhaInicial:\n${instrucao}`,
      ).toBe(true);
    }
  });

  it('nunca entra numa URLSearchParams', () => {
    const suspeitas = COM_SENHA.filter((instrucao) =>
      /URLSearchParams|searchParams|\.set\(/.test(instrucao),
    );
    expect(suspeitas, 'senha em parâmetro de consulta fica no histórico do balcão').toEqual([]);
  });

  it('nunca entra num redirect nem num falhar', () => {
    const suspeitas = COM_SENHA.filter((instrucao) => /redirect\(|falhar\(/.test(instrucao));
    expect(suspeitas, 'senha no destino viaja no Referer de toda a página').toEqual([]);
  });

  it('o cookie que a carrega é httpOnly, sameSite=strict e de caminho restrito', () => {
    const sessao = readFileSync(join(import.meta.dirname, 'sessao-gestor.ts'), 'utf8');
    const trecho = sessao.slice(
      sessao.indexOf('export async function guardarSenhaDeUmaVez'),
      sessao.indexOf('export async function lerSenhaDeUmaVez'),
    );

    expect(trecho).toContain('httpOnly: true');
    expect(trecho).toContain("sameSite: 'strict'");
    // Nunca `/admin`: o cookie não pode acompanhar a navegação pelo painel.
    expect(trecho).toContain('CAMINHO_DA_TELA[tela]');
    expect(trecho).toContain('maxAge: SEGUNDOS_NA_TELA');
  });
});
