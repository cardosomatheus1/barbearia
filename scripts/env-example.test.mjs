import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * O `.env.example` é **a lista**, e a lista tinha sete de trinta.
 *
 * ## Por que isto é guarda de go-live, e não capricho
 *
 * O `AGENT_AUTHORITY.md` trata "variável de ambiente que não está no
 * `.env.example`" como parada obrigatória, e o próprio arquivo diz de si mesmo
 * que é a lista. Só que ele listava `DATABASE_URL`, `STAFF_EMAIL_PEPPER` e mais
 * cinco — enquanto o código lia `MFA_SECRET_KEY`, `API_KEY_PEPPER`,
 * `WEBHOOK_SECRET_KEY`, `WHATSAPP_TOKEN_KEY`, `PSP_MODO`, `FISCAL_MODO` e o
 * resto.
 *
 * **Todas as chaves de cifra estavam de fora.** Elas falham alto quando
 * ausentes, o que é a decisão certa — e transforma o dia do deploy numa
 * sequência de subir, quebrar, ler o erro, acrescentar uma variável, repetir.
 * Pior: `PSP_MODO` e `FISCAL_MODO` **não** falham alto (ausente é "nenhum", de
 * propósito), então a instalação sobe, parece pronta, e não cobra nem emite
 * nota. Uma lista incompleta é como alguém conclui que `WEBHOOK_SECRET_KEY` é
 * opcional.
 *
 * ## Por que derivada, e não uma lista ao lado
 *
 * Porque a lista ao lado é exatamente a que ninguém atualiza — é o defeito que
 * este teste existe para pegar, e cometê-lo aqui dentro seria irônico. A
 * varredura lê `process.env[...]` do **fonte** dos pacotes e das aplicações.
 */

const RAIZ = join(import.meta.dirname, '..');

/** Onde o produto roda. `scripts/` e teste ficam de fora — ver `SO_DE_FORA`. */
const PRODUCAO = ['packages', 'apps'];

/**
 * O que o produto lê e **não** vai para o `.env.example`, com o motivo.
 *
 * Não é "as que dão trabalho": é a lista das que não são configuração de quem
 * instala, e cada linha diz por quê.
 */
const SO_DE_FORA = {
  NODE_ENV: 'do runtime, não de quem instala',
  APP_VERSION: 'injetada pelo build',
  DATABASE_URL: 'já está no arquivo',
  // Ambiente de teste e de medição: quem os define é o próprio script.
  SEED_DATABASE_URL: 'suíte de integração; definida por scripts/*/test.sh',
  APP_DATABASE_URL: 'idem',
  DEMO_DATABASE_URL: 'medição; definida por scripts/medicao.sh',
  MEDICAO_PRINTS: 'medição',
  MEDICAO_SLUG: 'medição',
  MEDICAO_SENHA: 'medição',
  SUPER_ADMIN_PASSWORD: 'script de criação da conta de plataforma, uma vez',
  RATE_LIMIT_SHORT: 'comentada no arquivo, com o padrão de produção',
  RATE_LIMIT_LONG: 'idem',
};

/** `NEXT_*` e `__NEXT_*` são internos do framework, não configuração nossa. */
const ehDoFramework = (nome) => nome.startsWith('NEXT_') || nome.startsWith('__NEXT') ||
  nome.startsWith('VERCEL');

function fontes(dir, achados = []) {
  for (const entrada of readdirSync(dir)) {
    if (entrada === 'node_modules' || entrada === 'dist' || entrada === '.next') continue;
    const caminho = join(dir, entrada);
    if (statSync(caminho).isDirectory()) {
      fontes(caminho, achados);
    } else if (/\.(ts|tsx|mjs)$/.test(entrada) && !entrada.includes('.test.')) {
      achados.push(caminho);
    }
  }
  return achados;
}

describe('o .env.example é a lista', () => {
  it('toda variável que o produto lê está declarada', () => {
    const declaradas = new Set(
      readFileSync(join(RAIZ, '.env.example'), 'utf8')
        .split('\n')
        .map((l) => l.replace(/^#\s*/, '').match(/^([A-Z_][A-Z0-9_]*)=/)?.[1])
        .filter(Boolean),
    );

    const lidas = new Map();
    for (const raiz of PRODUCAO) {
      for (const arquivo of fontes(join(RAIZ, raiz))) {
        const codigo = readFileSync(arquivo, 'utf8');
        for (const casa of codigo.matchAll(/process\.env(?:\[['"]([A-Z_][A-Z0-9_]*)['"]\]|\.([A-Z_][A-Z0-9_]*))/g)) {
          const nome = casa[1] ?? casa[2];
          if (!lidas.has(nome)) lidas.set(nome, arquivo.slice(RAIZ.length + 1));
        }
      }
    }

    const faltando = [...lidas]
      .filter(([nome]) => !declaradas.has(nome) && !SO_DE_FORA[nome] && !ehDoFramework(nome))
      .map(([nome, onde]) => `${nome} (lida em ${onde})`);

    expect(
      faltando,
      'variável lida pelo produto e ausente do .env.example. ' +
        'Ou ela entra no arquivo, ou entra em SO_DE_FORA com o motivo escrito — ' +
        'uma lista incompleta é como alguém conclui que a chave de cifra é opcional.',
    ).toEqual([]);
  });

  it('a guarda enxerga a variável que não está declarada', () => {
    /**
     * Guarda que não alcança o defeito que a motivou é pior que guarda nenhuma.
     * Esta prova o alcance com as duas formas que o código usa.
     */
    const declaradas = new Set(['JA_ESTA']);
    const acha = (codigo) =>
      [...codigo.matchAll(/process\.env(?:\[['"]([A-Z_][A-Z0-9_]*)['"]\]|\.([A-Z_][A-Z0-9_]*))/g)]
        .map((m) => m[1] ?? m[2])
        .filter((n) => !declaradas.has(n));

    expect(acha(`const a = process.env['MFA_SECRET_KEY'];`)).toEqual(['MFA_SECRET_KEY']);
    expect(acha(`const b = process.env.FISCAL_MODO;`)).toEqual(['FISCAL_MODO']);
    expect(acha(`const c = process.env['JA_ESTA'];`)).toEqual([]);
  });
});
