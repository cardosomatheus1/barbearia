import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * R11 — lê a implementação expandida das fachadas do admin.
 *
 * Guardas antigas não devem depender de o código estar em um monólito. Elas
 * perguntam pelo comportamento/contrato; este helper devolve a mesma superfície
 * textual depois da partição por domínio.
 */
function juntar(pasta) {
  return readdirSync(pasta)
    .filter((nome) => nome.endsWith('.ts'))
    .sort()
    .map((nome) => readFileSync(join(pasta, nome), 'utf8'))
    .join('\n');
}

export const fonteAdminApi = () => juntar('apps/web/src/lib/admin-api');
export const fonteAcoesAdmin = () => juntar('apps/web/src/app/admin/acoes');
