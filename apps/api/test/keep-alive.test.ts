import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ajustarKeepAlive,
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_MS,
} from '../src/common/keep-alive.js';

/**
 * A conexão ociosa da API vive mais que a do proxy.
 *
 * O que este teste prende não é um número: é a **ordem** entre os dois e o fato
 * de o ajuste ser aplicado. Os dois defeitos que ele evita são silenciosos — um
 * 502 a cada tantas requisições, num log que não é o nosso.
 */
describe('keep-alive da API', () => {
  it('o servidor passa a fechar depois de quem está na frente', () => {
    const servidor = { keepAliveTimeout: 5_000, headersTimeout: 60_000 };
    ajustarKeepAlive(servidor);

    // 60s é o padrão de ALB, nginx e Cloudflare. Fechar antes deles é a corrida
    // que produz `ECONNRESET` no meio de um pedido legítimo.
    expect(servidor.keepAliveTimeout).toBeGreaterThan(60_000);
  });

  it('o tempo de cabeçalho é maior que o de conexão ociosa', () => {
    /**
     * Invertidos, é `headersTimeout` quem derruba a conexão e o problema volta
     * com outro nome. É a ordem que a documentação do Node pede e a que se
     * esquece ao mexer num dos dois.
     */
    expect(HEADERS_TIMEOUT_MS).toBeGreaterThan(KEEP_ALIVE_MS);
  });

  it('o `main.ts` aplica o ajuste', () => {
    /**
     * Leitura de texto, e é o que dá para fazer: aquele arquivo não é montado
     * por teste nenhum — é justamente por isso que o ajuste mora fora dele. O
     * que este caso impede é o ajuste existir e ninguém o chamar, que é o
     * formato de defeito mais caro deste repositório (o gatilho inerte da
     * migração 0079 ficou dois commits assim).
     */
    const fonte = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(fonte).toContain('ajustarKeepAlive');
  });
});
