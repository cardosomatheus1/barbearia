/**
 * A trava da semente de demonstração, pelo critério que de fato separa os casos.
 *
 * ## Por que o host não servia
 *
 * A versão anterior recusava alvo remoto conferindo o **host** de `API_URL`, e
 * a lista de permitidos incluía `api` — o nome do serviço dentro do compose. O
 * próprio comentário dela dizia que o defeito era "`API_URL` apontar para
 * `api:3000` independentemente de o compose estar num notebook ou num VPS", e
 * era exatamente isso que continuava acontecendo: rodar a semente no servidor
 * de produção passava pela trava sem tropeçar.
 *
 * ## O que separa os casos é a senha
 *
 * O perigo nunca foi o endereço: é **entrar como dono com uma senha publicada
 * no repositório**. Quem alcançar a porta lê base de clientes com telefone e
 * ficha, caixa, comanda, fiado, exportação LGPD, chaves de API e cadastro de
 * webhook — que é o ponto de saída de rede do produto.
 *
 * Então a regra é:
 *
 * | Senha | Instalação | O que acontece |
 * |---|---|---|
 * | a publicada | de desenvolvimento | passa — é a demonstração de sempre |
 * | a publicada | **de verdade** | recusa |
 * | uma própria, forte | qualquer | passa |
 *
 * ## E "de verdade" também não é o host
 *
 * A primeira tentativa de conserto trocou o host pela senha e **continuou
 * furada**: com a senha publicada e o host `api` — que é o caso dentro do
 * compose, no VPS — ela passava. O host não distingue nada, nem antes nem
 * depois.
 *
 * O que distingue é a instalação, e ela se anuncia por dois sinais que o
 * processo já tem na mão:
 *
 * - `NODE_ENV=production`, que `deploy/compose.yml` define e o compose de
 *   desenvolvimento não;
 * - `WEB_URL` apontando para um endereço que não é esta máquina — é o endereço
 *   que vai dentro das mensagens ao cliente, então ele nunca é local numa
 *   instalação real.
 *
 * Qualquer um dos dois basta. Dois sinais e não um porque quem montar um
 * terceiro jeito de subir isto vai esquecer de um deles.
 *
 * Arquivo próprio porque `semear-demo.mjs` executa ao ser importado: uma regra
 * de segurança que não dá para exercitar em teste é uma regra que ninguém
 * verifica.
 */

/** A senha que está escrita no repositório, e que por isso não vale numa instalação real. */
export const SENHA_PUBLICADA = 'testeteste';

/**
 * Hosts que são a própria máquina. `api` está aqui porque é o nome do serviço
 * no compose — e é justamente por ele não distinguir notebook de VPS que ele
 * **não** decide nada sozinho.
 */
export const LOCAIS = ['localhost', '127.0.0.1', '::1', 'api', 'host.docker.internal'];

/** O piso do domínio. Baixá-lo aqui seria baixá-lo no produto inteiro. */
export const MINIMO_DA_SENHA = 10;

const hostDe = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

/** A instalação é real? Um sinal basta. */
export function ehInstalacaoDeVerdade({ nodeEnv, webUrl } = {}) {
  if (nodeEnv === 'production') return true;
  const host = hostDe(webUrl);
  return host !== '' && !LOCAIS.includes(host);
}

export function podeSemear({ host, senha, nodeEnv, webUrl }) {
  if (!senha || senha.length < MINIMO_DA_SENHA) {
    return {
      ok: false,
      motivo:
        `senha de ${senha ? senha.length : 0} caracteres: o mínimo do produto são ${MINIMO_DA_SENHA}.`,
    };
  }

  if (senha !== SENHA_PUBLICADA) return { ok: true };

  const real = ehInstalacaoDeVerdade({ nodeEnv, webUrl }) || !LOCAIS.includes(host);
  if (!real) return { ok: true };

  return {
    ok: false,
    motivo:
      'instalação de verdade com a senha publicada no repositório.\n' +
      '  Esta semente cria uma conta de **dono**. Num endereço que a internet\n' +
      '  alcança, isso é uma porta aberta para base de clientes, caixa, fiado,\n' +
      '  exportação LGPD e cadastro de webhook.\n' +
      '  Defina SEMENTE_SENHA com uma senha sua e rode de novo.',
  };
}
