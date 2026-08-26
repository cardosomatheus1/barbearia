/**
 * O que os seis módulos de ação compartilhavam — copiado, não extraído.
 *
 * As **327 primeiras linhas** de `operacao.ts`, `produto.ts`,
 * `agenda-financeiro.ts`, `clientes-conta.ts`, `crescimento-plataforma.ts` e
 * `onboarding.ts` eram byte a byte idênticas. Parece o mesmo movimento que
 * partiu `admin-api.ts` por domínio — só que lá o compartilhado virou `core.ts`
 * e aqui o cabeçalho foi copiado seis vezes, com os comentários longos junto.
 *
 * O caso mais caro é `MODALIDADES`, que ficou escrita **sete** vezes contando a
 * do domínio: `modalidadeDeSinal` devolve `'nenhum'` para valor desconhecido, de
 * propósito — entrada de formulário é entrada externa. Com seis cópias, uma
 * modalidade nova esquecida num arquivo faz aquele domínio **salvar "sem sinal"**
 * sobre uma escolha que a pessoa fez, sem erro e sem tela vermelha. A SPEC já
 * registra "cartão de garantia" como lacuna, então a quinta modalidade tem hora
 * marcada para chegar.
 *
 * Vale igual para os auxiliares: corrigir `falhar` num arquivo deixava cinco
 * cópias antigas.
 *
 * ## Por que aqui e não num `'use server'`
 *
 * Módulo com a diretiva só pode exportar função assíncrona — `MODALIDADES`,
 * `TETO_DO_ARQUIVO` e o tipo não passariam. Este arquivo é comum, os seis o
 * importam, e cada um continua sendo `'use server'` com as próprias ações.
 */
import { redirect } from 'next/navigation';

import { centavosDoCampo } from '@/lib/dinheiro';
import { guardarRascunho, guardarRecusa, lerSessaoGestor } from '@/lib/sessao-gestor';

/**
 * A modalidade vinda do `select`, conferida antes de virar corpo de requisição.
 *
 * Campo de formulário é entrada externa. Um valor fora da lista subiria até a
 * borda da API e voltaria como 400 genérico — e a tela diria "não deu para
 * salvar" sobre um campo que a pessoa nem tocou.
 */
export const MODALIDADES = new Set(['nenhum', 'fixo', 'percentual', 'total']);
export type ModalidadeDoFormulario = 'nenhum' | 'fixo' | 'percentual' | 'total';

export function modalidadeDeSinal(valor: string): ModalidadeDoFormulario {
  return MODALIDADES.has(valor) ? (valor as ModalidadeDoFormulario) : 'nenhum';
}
export const texto = (form: FormData, campo: string): string => String(form.get(campo) ?? '').trim();
export const numero = (form: FormData, campo: string, padrao: number): number => {
  const valor = Number(form.get(campo));
  return Number.isFinite(valor) ? valor : padrao;
};
/**
 * Recusa: o código na URL e **a frase do domínio** junto, num cookie.
 *
 * O código sozinho era o que a tela recebia, e cada tela traduzia o que ela
 * conhecia num `Record<string, string>` com `?? 'Não deu para salvar. Tente de
 * novo.'` no fim. Medido: os controllers mapeiam 239 códigos e os mapas das
 * telas cobrem 142 — **97 recusas** chegavam à barbearia como a frase genérica.
 *
 * O custo não é cosmético. A recepcionista digita 30% numa casa com teto de
 * 20%, e o domínio devolve *"O desconto máximo desta barbearia é R$ X"* — uma
 * frase escrita de propósito, com o número dentro, porque o comentário da rota
 * diz que *"recusado sem o número manda a recepção adivinhar"*. Ela viajava
 * pela rede inteira e era descartada na última linha: o que aparecia era "Tente
 * de novo", e a pessoa tentava de novo, para sempre.
 *
 * A frase vai por **cookie** e não pela URL, e isso é a regra do código de erro
 * que vai para o endereço: o que fica no histórico do navegador, no
 * autocompletar e no referrer não nomeia mecanismo nem carrega valor. O código
 * continua na URL porque é ele que a tela usa para decidir **onde** desenhar a
 * recusa; a frase é só o texto.
 *
 * `guardarRecusa` existe desde o bloco 98 e era escrita só por
 * `guardarOQueFoiDigitado` — o mecanismo estava pronto e ligado num caminho só.
 */
export async function falhar(
  rota: string,
  erro: string | { readonly code: string; readonly message: string },
): Promise<never> {
  const code = typeof erro === 'string' ? erro : erro.code;
  if (typeof erro !== 'string') await guardarRecusa(erro.message);
  const separador = rota.includes('?') ? '&' : '?';
  redirect(`${rota}${separador}erro=${encodeURIComponent(code)}`);
}
/**
 * Guarda o que foi digitado antes de recusar (bloco 98).
 *
 * A recusa voltava com a frase certa e o formulário **vazio**: quem montou um
 * público de sete campos recomeçava do zero por um número que faltava.
 *
 * Só os campos que a tela sabe repor — `FormData` traz botão, chave de
 * idempotência e campo escondido junto, e reencher a tela com eles seria
 * devolver estado que ninguém digitou. A lista é da tela porque é ela que sabe
 * o que tem `defaultValue`.
 */
export async function guardarOQueFoiDigitado(
  form: FormData,
  campos: readonly string[],
  mensagem?: string,
): Promise<void> {
  // A frase do domínio junto: ela diz **qual** campo está errado, e a tela
  // mostrava uma genérica sobre um formulário de sete campos.
  if (mensagem) await guardarRecusa(mensagem);
  const rascunho: Record<string, string> = {};
  for (const campo of campos) {
    const valor = form.get(campo);
    /**
     * Campo ausente vira string vazia, e não some.
     *
     * Some, ele volta ao **padrão** na próxima renderização — e o padrão da
     * caixa "Começar ligada" é marcada. Quem desmarcou de propósito e levou uma
     * recusa por outro campo encontrava a caixa marcada de novo: a tela
     * desfazendo em silêncio uma decisão que alguém tomou.
     */
    rascunho[campo] = typeof valor === 'string' ? valor : '';
  }
  await guardarRascunho(rascunho);
}
/**
 * Teto do arquivo de importação, em bytes — o mesmo que a API recusa.
 *
 * Conferido aqui também para que o arquivo grande demais nem seja lido na
 * memória do servidor de tela antes de a API dizer não. Repetido em vez de
 * importado do pacote da API porque `apps/web` não depende dela: os dois falam
 * HTTP, e um número é barato de duplicar com o motivo escrito.
 */
export const TETO_DO_ARQUIVO = 8 * 1024 * 1024;

export async function exigirSessao(): Promise<string> {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');
  return token;
}


/** Valor em centavos vindo do formulário, compartilhado entre domínios. */
export async function centavos(form: FormData, campo: string, rota: string): Promise<number> {
  const valor = centavosDoCampo(texto(form, campo));
  if (valor === null) return falhar(rota, 'valor_invalido');
  return valor;
}

/** Campo opcional: vazio é zero, mas escrito errado continua sendo erro. */
export async function centavosOpcionais(form: FormData, campo: string, rota: string): Promise<number> {
  return texto(form, campo) === '' ? 0 : centavos(form, campo, rota);
}
