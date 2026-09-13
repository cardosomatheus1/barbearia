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
     * O corpo também precisa de folga, e pela mesma contenção do gancho acima.
     *
     * `reemitir a senha também derruba as sessões abertas` estourou os 5s de
     * padrão do vitest na esteira. Ele não é lento: **805 ms** medidos nesta
     * máquina, com a suíte inteira em 82s. Na esteira as mesmas 12 suítes
     * levaram 366s — 4,5x —, e este teste em particular passou de 6,2x, porque
     * ele deriva `scrypt` **três vezes** (criar a conta, entrar, reemitir) e o
     * scrypt é caro de propósito: é a única coisa aqui que disputa CPU com as
     * outras nove suítes em vez de disputar o banco.
     *
     * O gancho ganhou folga no bloco 13 porque a semente é lenta; o corpo ficou
     * no padrão, e é no corpo que mora o custo desta suíte. `onboarding` já
     * tinha cobrado a mesma conta, pelo mesmo motivo e com o mesmo número.
     *
     * Trinta segundos são ~37x o pior caso medido, e continuam reprovando
     * travamento de verdade — não é tolerância a lentidão.
     */
    testTimeout: 30_000,
  },
});
