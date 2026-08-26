/**
 * As comodidades da unidade — lista fechada, escrita **uma vez** (bloco 105).
 *
 * O comentário da migração 0007 já dizia que a lista mora aqui, e a 0070 repete
 * isso ao lado das especialidades. Ela morava, na verdade, dentro da tela de
 * onboarding: três pares valor/nome num `const` local. Enquanto só aquela tela
 * a usava, a diferença não aparecia — o filtro do marketplace precisou dela e a
 * pergunta virou "copio ou movo?", que é a mesma pergunta de `secoes.ts` e dos
 * rótulos de campanha, e as duas vezes a cópia perdeu.
 *
 * O valor é o que vai ao banco e à URL do filtro; o rótulo é o que a pessoa lê.
 * São coisas diferentes de propósito: renomear "Acessível" para "Acessibilidade"
 * não pode invalidar o cadastro de mil e duzentas barbearias nem quebrar um link
 * de busca que alguém salvou.
 */

/**
 * ## A mudança veio de fonte errada, e o custo foi apagar cadastro
 *
 * O bloco 105 moveu a lista para cá — mas moveu **as três que a tela de
 * onboarding tinha**, e não as seis que `AMENITIES`, a borda da API e o banco
 * já tinham. O produto ficou com duas listas do mesmo fato: a curta, que a tela
 * desenha, e a longa, que a API aceita e a página pública rotula.
 *
 * O sintoma não era divergência futura — era perda de dado, e silenciosa.
 * `saveBusiness` grava `amenities` de forma **absoluta** (é o único campo que
 * não segue "ausente = não mexa", e isso é decisão escrita: desmarcar todas
 * precisa ser possível). Com o formulário desenhando três caixas, salvar a
 * etapa 2 mandava a lista das três — e `card`, `pix` e `cash` sumiam do banco.
 * As tags "Cartão / Pix / Dinheiro" caíam da página pública, e não havia tela
 * que as trouxesse de volta.
 *
 * O comentário dentro do próprio formulário ainda falava em "as **cinco**
 * comodidades que a página pública mostra". Cinco: a lista já tinha mudado
 * debaixo dele pelo menos duas vezes.
 *
 * ## Meio de pagamento aqui e em `payment_methods`
 *
 * `card`, `pix` e `cash` também existem em `locations.payment_methods`
 * (`MEIOS_ACEITOS`, com `CHECK` desde a 0098). São o mesmo fato em duas
 * colunas, e consolidá-las é migração com movimentação de dado — fica como
 * lacuna declarada. O que **não** dá para fazer é resolver a duplicação
 * encurtando esta lista: hoje a página pública lê só `amenities`, então tirar
 * os três daqui é tirar meio de pagamento da vista do cliente.
 */
export const COMODIDADES = [
  'wifi',
  'card',
  'pix',
  'cash',
  'parking',
  'accessible',
] as const;

export type Comodidade = (typeof COMODIDADES)[number];

export const ROTULO_DA_COMODIDADE: Readonly<Record<Comodidade, string>> = {
  wifi: 'Wi-Fi',
  card: 'Cartão',
  pix: 'Pix',
  cash: 'Dinheiro',
  parking: 'Estacionamento',
  accessible: 'Acessível',
};

export const ehComodidade = (valor: string): valor is Comodidade =>
  (COMODIDADES as readonly string[]).includes(valor);
