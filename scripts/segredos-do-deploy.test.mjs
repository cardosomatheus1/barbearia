import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * O gerador de segredos do deploy, **executado**.
 *
 * ## O defeito que este arquivo existe para não deixar voltar
 *
 * `deploy/instalar.sh` morria na primeira execução — a única que importa, porque
 * é a de quem está instalando pela primeira vez num VPS vazio. A função que lê
 * uma variável do `.env` é um pipeline que começa em `grep`; com o arquivo
 * vazio o `grep` sai com 1, o `pipefail` propaga o 1 até o fim do pipeline, a
 * atribuição herda o status e o `set -e` mata o script **antes de imprimir a
 * primeira linha**.
 *
 * O sintoma era o pior possível: nenhuma mensagem, nenhum erro, e um servidor
 * que parecia ter instalado. Quem descobriu foi uma pessoa lendo o código
 * depois de o site não subir.
 *
 * ## Por que executar, e não ler o texto
 *
 * Uma guarda que procurasse `|| true` no fonte estaria conferindo a **forma do
 * conserto**, não a propriedade. A propriedade é: *num arquivo vazio, os oito
 * saem preenchidos; numa segunda passada, saem idênticos*. Só rodando dá para
 * afirmar isso — e é rodando que se pega o próximo pipeline frágil, que não vai
 * se parecer com este.
 */

const RAIZ = join(import.meta.dirname, '..');
const SCRIPT = join(RAIZ, 'deploy', 'segredos.sh');

const OBRIGATORIOS = [
  'POSTGRES_PASSWORD',
  'APP_DB_PASSWORD',
  'STAFF_EMAIL_PEPPER',
  'MARKETPLACE_ORIGIN_SECRET',
  'API_KEY_PEPPER',
  'MFA_SECRET_KEY',
  'WEBHOOK_SECRET_KEY',
  'WHATSAPP_TOKEN_KEY',
];

function rodar(arquivo, dominio = 'barbearia.example', email = 'dono@barbearia.example') {
  return execFileSync('bash', [SCRIPT, arquivo, dominio, email], { encoding: 'utf8' });
}

/** `NOME="valor"` → mapa. É o mesmo formato que o compose lê. */
function lerEnv(arquivo) {
  const mapa = {};
  for (const linha of readFileSync(arquivo, 'utf8').split('\n')) {
    const m = linha.match(/^([A-Z_]+)="?(.*?)"?$/);
    if (m) mapa[m[1]] = m[2];
  }
  return mapa;
}

describe('os segredos do deploy', () => {
  it('num .env vazio, gera os oito — e é este o caso que quebrava', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'segredos-'));
    const arquivo = join(pasta, '.env');
    writeFileSync(arquivo, '');

    const saida = rodar(arquivo);
    const env = lerEnv(arquivo);

    const faltando = OBRIGATORIOS.filter((n) => !env[n]);
    expect(
      faltando,
      'variável ausente depois da primeira execução: o instalador morre em silêncio ' +
        'e o servidor parece instalado sem estar.',
    ).toEqual([]);

    // Todas geradas, nenhuma preservada: o arquivo estava vazio.
    for (const nome of OBRIGATORIOS) expect(saida).toContain(`++  ${nome}`);
  });

  it('o segredo gerado tem tamanho de segredo', () => {
    // Um `openssl` ausente devolveria string vazia e o `.env` sairia com
    // `MFA_SECRET_KEY=""` — que passa numa checagem de presença e falha alto só
    // quando a aplicação subir.
    const pasta = mkdtempSync(join(tmpdir(), 'segredos-'));
    const arquivo = join(pasta, '.env');
    rodar(arquivo);
    const env = lerEnv(arquivo);

    for (const nome of OBRIGATORIOS) {
      expect(env[nome].length, `${nome} curto demais: "${env[nome]}"`).toBeGreaterThan(20);
    }
    // 32 bytes em base64 são 44 caracteres, e a aplicação recusa outro tamanho.
    expect(Buffer.from(env['MFA_SECRET_KEY'], 'base64')).toHaveLength(32);
    expect(Buffer.from(env['WEBHOOK_SECRET_KEY'], 'base64')).toHaveLength(32);
    expect(Buffer.from(env['WHATSAPP_TOKEN_KEY'], 'base64')).toHaveLength(32);
  });

  it('rodar de novo preserva tudo — trocar um deles tranca a barbearia para fora', () => {
    /**
     * O instalador é feito para ser repetido: quem conserta o DNS e roda de
     * novo não pode perder o banco. Regerar `STAFF_EMAIL_PEPPER` faria ninguém
     * mais conseguir entrar (é ele que indexa o login), e regerar as senhas do
     * banco deixaria o volume existente inacessível.
     */
    const pasta = mkdtempSync(join(tmpdir(), 'segredos-'));
    const arquivo = join(pasta, '.env');

    rodar(arquivo);
    const antes = lerEnv(arquivo);

    const saida = rodar(arquivo);
    const depois = lerEnv(arquivo);

    for (const nome of OBRIGATORIOS) {
      expect(depois[nome], `${nome} mudou entre duas execuções`).toBe(antes[nome]);
      expect(saida).toContain(`==  ${nome}`);
    }
  });

  it('o domínio é sobrescrito, e os interruptores das integrações não', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'segredos-'));
    const arquivo = join(pasta, '.env');

    rodar(arquivo, 'antigo.example');
    // Alguém ligou a Stripe depois de instalar.
    writeFileSync(arquivo, `${readFileSync(arquivo, 'utf8')}`.replace('PSP_MODO="nenhum"', 'PSP_MODO="stripe"'));

    rodar(arquivo, 'novo.example');
    const env = lerEnv(arquivo);

    // Quem roda de novo com outro domínio está dizendo que o domínio mudou.
    expect(env['DOMINIO']).toBe('novo.example');
    // Já ligar a Stripe é decisão de quem opera: reinstalar não pode desligá-la.
    expect(env['PSP_MODO']).toBe('stripe');
  });

  it('a guarda pega um pipeline frágil como o que quebrou', () => {
    /**
     * Guarda que não fica vermelha não guarda nada. Aqui a quebra é a de
     * verdade: a versão do `ler()` sem `|| true`, com `set -euo pipefail`,
     * contra um arquivo vazio.
     */
    const pasta = mkdtempSync(join(tmpdir(), 'segredos-'));
    const quebrado = join(pasta, 'quebrado.sh');
    const arquivo = join(pasta, '.env');
    writeFileSync(arquivo, '');
    writeFileSync(
      quebrado,
      [
        'set -euo pipefail',
        `ENV="${arquivo}"`,
        'ler() { grep -E "^$1=" "$ENV" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d \'"\'; }',
        'manter() { local atual; atual="$(ler "$1")"; printf "  ++  %s\\n" "$1"; }',
        'manter POSTGRES_PASSWORD',
      ].join('\n'),
    );

    let morreu = false;
    try {
      execFileSync('bash', [quebrado], { encoding: 'utf8' });
    } catch {
      morreu = true;
    }
    expect(morreu, 'o pipeline frágil deixou de falhar: este teste perdeu o sentido').toBe(true);
  });
});
