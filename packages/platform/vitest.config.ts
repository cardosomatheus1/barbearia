import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Suítes de integração compartilham o mesmo banco e cada uma trunca as
    // tabelas no `beforeEach`. Em paralelo, uma apaga a semente da outra — foi
    // exatamente o que aconteceu quando a segunda suíte deste pacote nasceu.
    fileParallelism: false,
    /**
     * O `beforeEach` destas suítes limpa e semeia o banco, e o portão roda dez
     * pacotes contra o **mesmo** Postgres: sob essa contenção o `TRUNCATE`
     * espera pela trava e o gancho passa dos 10s que o vitest dá por padrão.
     *
     * O estrago não é o gancho que estoura — é o que sobra dele. O vitest
     * desiste de esperar e segue para o próximo teste, mas as instruções já
     * enviadas continuam correndo: elas caem **depois** do `TRUNCATE` seguinte
     * e o teste de baixo morre com chave duplicada, num id que ele nem
     * escreveu. Foi assim que a falha apareceu ora em `finance`, ora em
     * `scheduling`, ora em `identity`, sempre em testes diferentes — o retrato
     * de uma corrida, e a razão de o suspeito nunca ser o teste que ficou
     * vermelho.
     *
     * 60s não é tolerância a lentidão: uma semente que passe disso está
     * travada, e aí o vermelho é legítimo.
     */
    hookTimeout: 60_000,
  },
});
