import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A recusa de uma ação mostra a frase que o **domínio** escreveu.
 *
 * Cada tela traduzia o código num `Record<string, string>` próprio, com um
 * `?? 'Tente de novo.'` no fim. Medido no bloco 120: os controllers mapeiam 239
 * códigos e os mapas das telas cobriam 142 — **97 recusas** chegavam à
 * barbearia como a frase genérica, incluindo o teto de desconto (que carrega o
 * valor em reais de propósito) e o vale acima da comissão.
 *
 * O `??` é o que torna isso invisível: nunca aparece caixa vazia, nunca o `tsc`
 * reclama, e a única pista é a recepcionista tentando de novo. Guarda derivada
 * porque uma tela nova nasce copiando a vizinha.
 *
 * ## As duas conferências
 *
 * 1. Nenhuma tela desenha `FALHA[erro]` à mão sobre o código que veio da URL —
 *    esse caminho é do `AvisoDeRecusa`, que lê o cookie primeiro.
 * 2. `falhar` passa o **objeto** e não `.code`, senão a frase nem é gravada.
 *
 * ## As isenções, e por que são estas
 *
 * As duas portas de entrada (`entrar`, `criar-conta`) mostram só o mapa da
 * tela, e está escrito nas duas: a frase da API sobre login e cadastro é
 * exatamente o que a regra de não revelar existência de cadastro existe para
 * não dizer. É o precedente do OTP, que responde igual para telefone existente
 * e inexistente.
 *
 * A isenção é **conquistada**: ela vale porque a tela não lê o cookie, e as
 * ações delas passam `resultado.code`. Uma tela nova que quisesse o mesmo teria
 * que fazer as duas coisas — não basta entrar numa lista.
 */

const RAIZ = new URL('..', import.meta.url).pathname;

const arquivos = (pasta) =>
  execFileSync('git', ['ls-files', pasta], { cwd: RAIZ, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

const ler = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

/** As telas que legitimamente escondem a frase do domínio: as portas de entrada. */
const PORTAS_DE_ENTRADA = /\/(entrar|criar-conta)\/page\.tsx$/;

describe('a recusa mostra a frase do domínio', () => {
  it('nenhuma tela traduz o código da URL por conta própria', () => {
    const escrevendoAMao = [];

    for (const f of arquivos('apps/web/src/app').filter((f) => f.endsWith('.tsx'))) {
      if (PORTAS_DE_ENTRADA.test(f)) continue;
      const texto = ler(f).replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      // `FALHA[erro]` é o código que voltou da ação, pela URL. `FALHA[x.code]`
      // é outra coisa: leitura que falhou nesta mesma renderização, sem ação e
      // portanto sem cookie — o mapa continua sendo a resposta certa ali.
      if (/\bFALHA\[erro\]/.test(texto)) escrevendoAMao.push(f);
    }

    expect(
      escrevendoAMao,
      'esta tela traduz o código da recusa à mão: use <AvisoDeRecusa erro={erro} mapa={FALHA} />, ' +
        'que mostra a frase que a API escreveu antes de cair no mapa',
    ).toEqual([]);
  });

  it('as ações passam o resultado inteiro, para a frase ser gravada', () => {
    const soOCodigo = [];

    for (const f of arquivos('apps/web/src/app').filter((f) => f.endsWith('acoes.ts'))) {
      const texto = ler(f);
      for (const [i, linha] of texto.split('\n').entries()) {
        if (!/\bfalhar\(/.test(linha) || !/resultado\.code/.test(linha)) continue;
        // As portas de entrada mandam o código de propósito, e o comentário
        // acima delas diz por quê. A isenção é o comentário, não o nome.
        const acima = texto.split('\n').slice(Math.max(0, i - 8), i).join('\n');
        if (/nunca a frase|porta de entrada/.test(acima)) continue;
        soOCodigo.push(`${f}:${i + 1}`);
      }
    }

    expect(
      soOCodigo,
      'esta ação joga fora a frase do domínio: passe `resultado`, não `resultado.code`',
    ).toEqual([]);
  });

  it('a varredura enxerga a forma antiga', () => {
    // Sem este caso, um regex que não casasse nada devolveria verde para
    // sempre — guarda que não alcança o defeito que a motivou.
    const antiga = "{FALHA[erro] ?? FALHA['request_failed']}";
    expect(/\bFALHA\[erro\]/.test(antiga)).toBe(true);
    expect(/\bFALHA\[erro\]/.test('{FALHA[resposta.code] ?? X}')).toBe(false);
  });
});
