import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Suítes de integração compartilham o mesmo banco e cada uma trunca as
    // tabelas no `beforeEach`. Em paralelo, uma apaga a semente da outra.
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
    /**
     * O cenário desta suíte nasce **no corpo**, não no gancho — e o corpo tinha
     * o padrão de 5s.
     *
     * Cada teste aqui precisa da própria barbearia, então `percorrer()` roda as
     * seis etapas dentro do `it`. Três deles montam **duas** casas, e o mais
     * pesado — a unidade da vizinha não é editável nem com o id na mão — soma um
     * `percorrer` inteiro a um `cadastrar`. Na esteira o arquivo leva 103s para
     * 18 testes: cerca de 6s por teste, contra um orçamento de 5. Ele reprovou
     * por isso, com a regra que ele prova intacta.
     *
     * O gancho já tinha folga porque a semente é lenta; o corpo não tinha, e é
     * onde a semente desta suíte mora. Trinta segundos pela mesma razão dos
     * sessenta acima: é cinco vezes o pior caso medido e continua reprovando um
     * travamento de verdade — não é tolerância a lentidão.
     */
    testTimeout: 30_000,
  },
});
