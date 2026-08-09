import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Suítes de integração compartilham o mesmo banco e cada uma trunca as
    // tabelas no `beforeEach`. Em paralelo, uma apaga a semente da outra — foi
    // exatamente o que aconteceu quando a segunda suíte deste pacote nasceu.
    fileParallelism: false,
  },
});
