import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],

    /**
     * Um arquivo por vez.
     *
     * Cada arquivo trunca as mesmas tabelas no `beforeEach`. Em paralelo, dois
     * truncando ao mesmo tempo travam um contra o outro.
     */
    fileParallelism: false,

    /**
     * Vinte segundos, e não os cinco do padrão.
     *
     * O padrão do vitest é pensado para teste unitário. Aqui cada caso sobe uma
     * aplicação Nest de verdade contra um Postgres de verdade, e os que criam
     * conta fazem quatro operações de **scrypt** — que é caro de propósito, é
     * essa a função dele.
     *
     * O número não é chute. Medido: `a recepcionista opera o balcão` custa
     * 840 ms nesta máquina, de quatro núcleos. Na esteira, num runner de dois
     * núcleos com o Postgres em contêiner e outras suítes disputando CPU, o
     * mesmo caso estourou os 5 s — seis a oito vezes mais lento, sem nada de
     * errado acontecendo.
     *
     * Um portão que reprova por variação legítima de máquina é pior que um
     * portão lento: ele ensina todo mundo a reexecutar em vez de olhar. Vinte
     * segundos ainda pegam o que importa — um teste que trava de verdade não
     * demora vinte segundos, ele não termina.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
