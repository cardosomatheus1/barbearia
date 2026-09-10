import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// As ações importam o mesmo alias do Next. Resolver os módulos reais permite
// testar a conversão do formulário sem substituir as regras de entrada.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
