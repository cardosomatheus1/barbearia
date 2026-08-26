#!/usr/bin/env node
/**
 * As três peças da rede de segurança do deploy, e por que elas têm guarda.
 *
 * Nenhuma das três falhou sozinha. Elas falharam **em cadeia**, e cada uma
 * escondeu a próxima — um `throw` de dez linhas no boot da API virou uma hora
 * de site fora:
 *
 * 1. a API não subia, e entrou em laço de reinício;
 * 2. o backup empacotava a mídia com `exec` no contêiner da API, então falhou
 *    com "container is restarting";
 * 3. `atualizar.sh` fazia backup **antes** de buscar o código, então parava ali
 *    — e a correção da API nunca chegava a ser construída, por mais vezes que
 *    o comando fosse repetido;
 * 4. `voltar.sh` reconstruía a versão anterior, que tinha o mesmo `throw`, e
 *    terminava imprimindo "no ar" sem conferir nada.
 *
 * O que as três têm em comum: só falham **quando são acionadas**. Um portão
 * verde não diz nada sobre elas, porque nada no portão as executa contra uma
 * aplicação quebrada. Por isso a guarda lê a forma dos scripts — e os testes
 * negativos de `backup-shell.test.mjs` executam o caso de verdade.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = process.env['REDE_RAIZ'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (p) => readFileSync(join(RAIZ, p), 'utf8');

/** Sem os comentários: eles citam o defeito, e a guarda casaria com a explicação. */
const semComentario = (texto) =>
  texto
    .split('\n')
    .map((linha) => (/^\s*#/.test(linha) ? '' : linha))
    .join('\n');

export function falhasDaRedeDeDeploy(raiz = RAIZ) {
  const problemas = [];
  const cobrar = (ok, msg) => {
    if (!ok) problemas.push(msg);
  };
  const lerAqui = (p) => semComentario(readFileSync(join(raiz, p), 'utf8'));

  const backup = lerAqui('deploy/backup.sh');
  const atualizar = lerAqui('deploy/atualizar.sh');
  const voltar = lerAqui('deploy/voltar.sh');

  // 1. O backup não pode exigir a aplicação de pé — é quando ele mais importa.
  cobrar(
    !/\$COMPOSE exec [^\n]*\bapi\b/.test(backup),
    'o backup voltou a usar `exec` na api: com a aplicação fora ele não roda',
  );
  cobrar(
    /\$COMPOSE run --rm --no-deps -T [^\n]*\bapi\b/.test(backup),
    'o backup deixou de empacotar a mídia num contêiner descartável',
  );

  // 2. Buscar o código antes do backup, senão uma API quebrada nunca é
  //    corrigida: o backup falha e o `set -e` para antes do `git reset`.
  const ordem = ['git fetch --quiet origin', 'deploy/backup.sh', '$COMPOSE run --rm preparar'];
  const posicoes = ordem.map((marca) => atualizar.indexOf(marca));
  cobrar(
    posicoes.every((p) => p >= 0),
    'atualizar.sh perdeu um dos três passos que a ordem protege',
  );
  cobrar(
    posicoes[0] >= 0 && posicoes[1] >= 0 && posicoes[0] < posicoes[1],
    'atualizar.sh voltou a fazer backup antes de buscar o código: API quebrada não se conserta',
  );
  cobrar(
    posicoes[1] >= 0 && posicoes[2] >= 0 && posicoes[1] < posicoes[2],
    'atualizar.sh migra antes do backup: o backup existe para poder desfazer a migração',
  );

  // 3. A volta confere saúde antes de se declarar bem-sucedida.
  cobrar(
    /curl -fsS --max-time \d+ "https:\/\/\$DOMINIO_NO_ENV\//.test(voltar),
    'voltar.sh deixou de conferir se o site responde depois de subir',
  );
  cobrar(
    /morrer "a versão/.test(voltar),
    'voltar.sh voltou a terminar em sucesso mesmo quando a versão anterior não sobe',
  );

  return problemas;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const problemas = falhasDaRedeDeDeploy();
  if (problemas.length > 0) {
    console.error(`rede de deploy: ${problemas.length} problema(s)\n`);
    for (const p of problemas) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('rede de deploy: backup sem a API, código antes do backup, volta conferida');
}
