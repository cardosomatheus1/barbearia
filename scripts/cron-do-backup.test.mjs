import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * O agendamento do backup, **executado**.
 *
 * ## O defeito que este arquivo existe para não deixar voltar
 *
 * A última linha do instalador instalava o cron do backup assim:
 *
 *     ( crontab -l 2>/dev/null | grep -v barbearia-backup; echo "$linha" ) | crontab -
 *
 * Num servidor recém-instalado o root **não tem crontab**. `crontab -l` sai com
 * 1, o `grep -v` recebe entrada vazia e sai com 1 também — porque "nenhuma linha
 * selecionada" é 1 no grep —, e o `pipefail` mata o subshell antes do `echo`.
 * O `crontab -` do outro lado do cano recebe entrada vazia e instala um crontab
 * **vazio**; o `set -e` derruba o instalador na sequência.
 *
 * O estrago é duplo e silencioso: o instalador nunca imprime `pronto`, e o
 * backup diário — a única cópia dos dados — simplesmente não existe. Ninguém
 * descobre no dia da instalação. Descobre-se no dia da restauração.
 *
 * ## Por que executar, e não ler o texto
 *
 * Procurar `|| true` no fonte conferiria a forma do conserto. A propriedade é
 * outra: *num servidor sem crontab nenhum, a linha do backup entra*. Só rodando
 * dá para afirmar isso — e é rodando que se pega o próximo pipeline frágil, que
 * não vai se parecer com este.
 *
 * O `crontab` daqui é um dublê num arquivo: o de verdade mexe no agendamento da
 * máquina que roda o teste, e um teste que instala cron na máquina de quem o
 * roda é um teste que ninguém roda duas vezes. O dublê imita a única coisa que
 * importa para o defeito — **`-l` sai com 1 quando não há crontab**.
 */

const RAIZ = new URL('..', import.meta.url).pathname;
const SCRIPT = join(RAIZ, 'deploy', 'cron-do-backup.sh');

/** Um `crontab` de mentira, guardado num arquivo, com o código de saída que importa. */
const DUBLE = `#!/usr/bin/env bash
arq="$FAKE_CRONTAB"
case "\${1:-}" in
  -l) [ -s "$arq" ] || { echo "no crontab for root" >&2; exit 1; }; cat "$arq" ;;
  -)  cat > "$arq" ;;
  *)  echo "uso não previsto pelo dublê: $*" >&2; exit 2 ;;
esac
`;

function preparar() {
  const pasta = mkdtempSync(join(tmpdir(), 'cron-'));
  const duble = join(pasta, 'crontab');
  const tabela = join(pasta, 'tabela.txt');
  writeFileSync(duble, DUBLE);
  chmodSync(duble, 0o755);
  return { pasta, tabela };
}

function rodar({ pasta, tabela }, destino = '/opt/barbearia') {
  return execFileSync('bash', [SCRIPT, destino], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${pasta}:${process.env.PATH}`, FAKE_CRONTAB: tabela },
  });
}

function tabelaAgora(tabela) {
  try {
    return readFileSync(tabela, 'utf8');
  } catch {
    return '';
  }
}

describe('o cron do backup', () => {
  it('sem crontab nenhum, instala a linha — e é este o caso que quebrava', () => {
    // Servidor recém-instalado: nem arquivo existe. `crontab -l` sai com 1 aqui,
    // igual ao de verdade, e era esse 1 que derrubava o instalador inteiro.
    const cenario = preparar();

    rodar(cenario);

    const tabela = tabelaAgora(cenario.tabela);
    expect(
      tabela,
      'o crontab ficou vazio: o backup diário não existe e ninguém é avisado. ' +
        'É o defeito que deixava a única cópia dos dados sem acontecer.',
    ).toContain('barbearia-backup');
    expect(tabela).toContain('17 4 * * *');
  });

  it('preserva o que já estava agendado', () => {
    // Quem opera a máquina pode ter cron próprio. Instalar o nosso não é
    // motivo para apagar o de ninguém.
    const cenario = preparar();
    writeFileSync(cenario.tabela, '0 3 * * * /usr/local/bin/coisa-do-dono\n');

    rodar(cenario);

    const tabela = tabelaAgora(cenario.tabela);
    expect(tabela, 'apagou o cron de quem já usava a máquina').toContain('coisa-do-dono');
    expect(tabela).toContain('barbearia-backup');
  });

  it('rodar de novo não duplica a linha', () => {
    // O instalador é feito para ser repetido. Duas linhas iguais fariam dois
    // `pg_dump` simultâneos às 04:17, no mesmo disco.
    const cenario = preparar();

    rodar(cenario);
    rodar(cenario);

    const quantas = tabelaAgora(cenario.tabela).split('\n').filter((l) => l.includes('barbearia-backup')).length;
    expect(quantas, 'a linha do backup foi instalada mais de uma vez').toBe(1);
  });

  it('o destino informado é o que vai para a linha', () => {
    const cenario = preparar();

    rodar(cenario, '/srv/outra-pasta');

    expect(tabelaAgora(cenario.tabela)).toContain('DESTINO=/srv/outra-pasta');
  });

  it('a guarda pega um pipeline frágil como o que quebrou', () => {
    /**
     * Guarda que não fica vermelha não guarda nada. Aqui a quebra é a de
     * verdade: a linha original, com `set -euo pipefail`, contra um `crontab -l`
     * que sai com 1 — que é o que acontece em toda máquina recém-instalada.
     */
    const { pasta, tabela } = preparar();
    const quebrado = join(pasta, 'quebrado.sh');
    writeFileSync(
      quebrado,
      [
        'set -euo pipefail',
        `export FAKE_CRONTAB="${tabela}"`,
        `export PATH="${pasta}:$PATH"`,
        'linha="17 4 * * * /usr/local/bin/barbearia-backup"',
        '( crontab -l 2>/dev/null | grep -v barbearia-backup; echo "$linha" ) | crontab -',
      ].join('\n'),
    );

    let morreu = false;
    try {
      execFileSync('bash', [quebrado], { encoding: 'utf8' });
    } catch {
      morreu = true;
    }

    expect(morreu, 'o pipeline frágil deixou de falhar: este teste perdeu o sentido').toBe(true);
    expect(
      tabelaAgora(tabela),
      'o pipeline frágil deixou de instalar crontab vazio: este teste perdeu o sentido',
    ).not.toContain('barbearia-backup');
  });
});
