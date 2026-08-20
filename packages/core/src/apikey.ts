import { PERMISSOES, PERMISSOES_DE_DINHEIRO, ehPermissao, type Permissao } from './permissoes.js';

/**
 * Chave de API pública: o que ela pode carregar (bloco 78).
 *
 * ## O que este arquivo decide
 *
 * Quais permissões cabem numa chave, e como uma chave se parece. Não sorteia
 * segredo — isso é `node:crypto` e mora em `identity`, porque `core` não tem
 * dependência nenhuma, nem a biblioteca padrão do Node.
 *
 * ## O escopo é uma permissão, e não um vocabulário paralelo
 *
 * A alternativa — `read:appointments`, `write:orders` e uma tabela de-para —
 * seria a sexta lista paralela deste repositório, e as cinco anteriores todas
 * divergiram. Aqui, uma permissão nova nasce disponível para a API sem ninguém
 * lembrar dela; e a que **não** pode ser dada continua não podendo pela mesma
 * razão que vale no painel.
 */

/**
 * O prefixo público de toda chave.
 *
 * Dois propósitos, e os dois são práticos: quem vê a chave num arquivo de
 * configuração sabe de que produto ela é, e um varredor de segredos em
 * repositório público reconhece o padrão. É o que a Stripe faz, e funciona.
 */
export const PREFIXO_DA_CHAVE = 'bd_';

/** Quantas chamadas uma chave faz por minuto. */
export const TETO_POR_MINUTO = 120;

/**
 * O que uma chave **não** pode carregar, nunca.
 *
 * Derivado de `PERMISSOES_DE_DINHEIRO`, e não escrito ao lado: o segundo fator
 * deste produto é derivado do prefixo e provado por sessão, com TOTP. Máquina
 * não digita TOTP — ou a chave seria inútil, ou alguém a isentaria da exigência
 * e a API pública viraria a porta sem segundo fator para o dinheiro que o balcão
 * só move com ele.
 *
 * A permissão de dinheiro que alguém acrescentar no bloco 90 entra aqui
 * sozinha, porque isto é a mesma constante que a `PermissaoGuard` usa.
 */
export const FORA_DA_API: readonly Permissao[] = PERMISSOES_DE_DINHEIRO;

/**
 * `customers.export` e `customers.anonymize` também ficam de fora.
 *
 * A primeira leva a base inteira num arquivo; a segunda é a única operação
 * irreversível do produto. Nenhuma das duas é integração — são atos de LGPD que
 * uma pessoa responde por, e uma chave num arquivo de configuração não responde
 * por nada.
 */
const IRREVERSIVEIS: readonly Permissao[] = ['customers.export', 'customers.anonymize'];

export const ESCOPOS_DISPONIVEIS: readonly Permissao[] = PERMISSOES.filter(
  (p) => !FORA_DA_API.includes(p) && !IRREVERSIVEIS.includes(p),
);

/**
 * Os escopos que **alguma rota da API pública honra hoje**.
 *
 * O catálogo derivado de `PERMISSOES` continua certo: ele é o que impede a
 * sexta lista paralela, e faz a permissão do bloco 90 nascer disponível para a
 * API sem ninguém lembrar dela. O que estava errado era a tela apresentar o
 * resultado sob o título "O que ela pode fazer" — trinta e uma caixas, das
 * quais duas existem.
 *
 * Duas consequências, e a segunda é a que preocupa: o dono emitia a chave do
 * ERP marcando `fiscal.issue` e `customers.view` porque o integrador pediu, e
 * nada respondia; e uma chave emitida hoje com `team.manage` ganharia o poder
 * **no dia** em que um bloco futuro declarasse `@Escopo` com esse nome, sem
 * ninguém reemitir nada nem decidir nada.
 *
 * A lista é curta e mora aqui porque `packages/core` não lê o fonte da API.
 * Quem impede a divergência é `scripts/escopo-com-rota.test.mjs`, que varre os
 * decoradores e cobra a igualdade: a rota nova aparece aqui ou o portão fica
 * vermelho. E o que **não** está nesta lista continua concedível — marcado na
 * tela como ainda sem rota, que é a regra deste repositório para gatilho que
 * ainda não funciona. Escondê-lo faria a lista parecer completa.
 */
export const ESCOPOS_COM_ROTA: readonly Permissao[] = ['appointments.view', 'appointments.create'];

/**
 * Por que a emissão ou a revogação de uma chave foi recusada.
 *
 * Mesma razão de `WebhookFailure`: a tela precisa da união para o mapa de
 * mensagens ter chave estreita, e `apps/web` não depende de `identity`.
 */
export type ApiKeyFailure =
  | 'pepper_ausente'
  | 'escopo_vazio'
  | 'escopo_desconhecido'
  | 'escopo_de_dinheiro'
  | 'escopo_irreversivel'
  | 'escopo_alem_do_ator'
  | 'chave_nao_encontrada'
  | 'motivo_obrigatorio';

export type FalhaDeEscopo =
  | 'escopo_vazio'
  | 'escopo_desconhecido'
  | 'escopo_de_dinheiro'
  | 'escopo_irreversivel';

export interface EscopoRecusado {
  readonly motivo: FalhaDeEscopo;
  readonly escopo?: string | undefined;
}

/**
 * Valida os escopos pedidos para uma chave.
 *
 * Devolve a lista limpa, ou o motivo da recusa. Erro explícito no tipo de
 * retorno, nunca `null` silencioso para significar falha.
 */
export function validarEscopos(
  pedidos: readonly string[],
): { readonly ok: true; readonly escopos: readonly Permissao[] } | { readonly ok: false; readonly recusa: EscopoRecusado } {
  if (pedidos.length === 0) {
    return { ok: false, recusa: { motivo: 'escopo_vazio' } };
  }

  const limpos: Permissao[] = [];
  for (const pedido of pedidos) {
    if (!ehPermissao(pedido)) {
      return { ok: false, recusa: { motivo: 'escopo_desconhecido', escopo: pedido } };
    }
    if (FORA_DA_API.includes(pedido)) {
      return { ok: false, recusa: { motivo: 'escopo_de_dinheiro', escopo: pedido } };
    }
    if (IRREVERSIVEIS.includes(pedido)) {
      return { ok: false, recusa: { motivo: 'escopo_irreversivel', escopo: pedido } };
    }
    if (!limpos.includes(pedido)) limpos.push(pedido);
  }

  return { ok: true, escopos: limpos };
}

/**
 * Ninguém concede o que não tem.
 *
 * A mesma regra do bloco 30, e pelo mesmo motivo: sem ela, criar uma chave
 * seria o caminho curto para se dar a permissão que o papel não tem. O que o
 * ator tem vem do **banco**, nunca do parâmetro — quem chama isto já leu de lá.
 */
export function escoposQueOAtorPodeDar(
  pedidos: readonly Permissao[],
  doAtor: readonly Permissao[],
): { readonly ok: true } | { readonly ok: false; readonly faltando: Permissao } {
  for (const pedido of pedidos) {
    if (!doAtor.includes(pedido)) return { ok: false, faltando: pedido };
  }
  return { ok: true };
}

/**
 * A chave inteira, como o integrador a recebe.
 *
 * `bd_<prefixo>.<segredo>`: o prefixo identifica a linha e fica no banco em
 * claro; o segredo existe **uma vez**, na resposta da criação, e depois só o
 * HMAC dele. É a postura da senha de primeiro acesso do bloco 29 — a diferença
 * é que aqui nem por mensagem ela reaparece.
 */
export function montarChave(prefixo: string, segredo: string): string {
  return `${PREFIXO_DA_CHAVE}${prefixo}.${segredo}`;
}

export interface ChavePartida {
  readonly prefixo: string;
  readonly segredo: string;
}

/**
 * Parte a chave apresentada pelo integrador.
 *
 * Devolve `null` para qualquer coisa fora do formato — e a conferência do
 * segredo, que é a que importa, acontece em tempo constante lá em `identity`.
 * Aqui a recusa é de forma, e recusar cedo evita ida ao banco por lixo.
 */
export function partirChave(bruta: string): ChavePartida | null {
  if (!bruta.startsWith(PREFIXO_DA_CHAVE)) return null;
  const resto = bruta.slice(PREFIXO_DA_CHAVE.length);
  const ponto = resto.indexOf('.');
  if (ponto <= 0) return null;

  const prefixo = resto.slice(0, ponto);
  const segredo = resto.slice(ponto + 1);
  if (!/^[0-9a-f]{12}$/.test(prefixo) || segredo.length < 32) return null;

  return { prefixo, segredo };
}
