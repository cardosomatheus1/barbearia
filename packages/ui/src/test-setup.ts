import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * O auto-cleanup do Testing Library depende dos globais do vitest, que estão
 * desligados aqui — sem isso, cada teste renderiza por cima do anterior e as
 * consultas por papel encontram elementos duplicados.
 */
afterEach(() => {
  cleanup();
});
