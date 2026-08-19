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

export const COMODIDADES = ['wifi', 'parking', 'accessible'] as const;

export type Comodidade = (typeof COMODIDADES)[number];

export const ROTULO_DA_COMODIDADE: Readonly<Record<Comodidade, string>> = {
  wifi: 'Wi-Fi',
  parking: 'Estacionamento',
  accessible: 'Acessível',
};

export const ehComodidade = (valor: string): valor is Comodidade =>
  (COMODIDADES as readonly string[]).includes(valor);
