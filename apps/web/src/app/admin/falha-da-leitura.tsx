/**
 * O que a tela mostra quando a **primeira leitura** dela não voltou.
 *
 * ## Por que não é uma frase só
 *
 * Porque são dois fatos diferentes, e o produto vinha dizendo um pelo outro.
 * Plano, Chaves de API, Webhooks, Fotos, Franquia e a lista de comandas abertas
 * respondiam *"Não deu para carregar. Recarregue a página"* sobre um **403** —
 * a recusa de permissão vestida de falha passageira. A convenção do repositório
 * já dizia que as duas mensagens são diferentes: *"Não entendi a pergunta"
 * manda a pessoa reformular para sempre um número que ela nunca poderá ver.*
 * Aqui era pior, porque a instrução era **recarregar**, e recarregar nunca ia
 * funcionar. A recepcionista recarrega o Plano até desistir do produto.
 *
 * - `forbidden` → sua conta não abre esta tela, e **quem libera é o dono**. Sem
 *   botão de tentar de novo: oferecer o gesto que não funciona é o defeito.
 * - qualquer outro → falha mesmo, e aí "tentar de novo" é a resposta certa.
 *
 * ## Quem chega aqui, agora que o menu esconde
 *
 * Desde o bloco 126 o menu não oferece o que a conta não abre, então ninguém
 * chega por navegação. Continua chegando quem tem o endereço salvo, quem
 * recebeu o link de um colega e quem teve a permissão removida ontem — e é para
 * essas três pessoas que a frase existe. Esconder do menu **e** mentir no
 * endereço seria trocar um defeito por outro.
 *
 * ## `data-recusa`, e por que a marca é no DOM
 *
 * A guarda que percorre o painel com cada papel (`scripts/percorrer.mjs`)
 * precisa saber, sem ambiguidade, se a tela **recusou**. A alternativa era uma
 * lista de frases — "Sua conta não…", "Só o dono…", "Você não tem permissão…" —
 * e lista de frases é a lista paralela de sempre: a tela nova escreve a
 * quadragésima primeira variação e a guarda fica verde sobre uma recusa que ela
 * não reconheceu.
 *
 * O atributo é o mesmo desenho de `data-secao`: a tela **declara** o que está
 * mostrando, e quem lê pergunta ao DOM.
 *
 * A frase não diz qual permissão falta: quem lê não pode fazer nada com o nome
 * dela, e nomear o mecanismo é o mesmo cuidado do código de erro que não vai
 * para a URL.
 */
/**
 * A marca que a guarda lê, **derivada do código** e nunca escrita à mão.
 *
 * Vinte telas já tinham a própria parede de leitura antes deste componente
 * existir, cada uma com a frase que só ela sabe escrever ("Só o dono administra
 * a equipe", "Sua conta não vê o resultado da barbearia — só quem tem acesso à
 * margem vê"). Trocar as vinte por um componente genérico apagaria justamente a
 * parte que presta.
 *
 * O que elas ganham é este spread: um lugar só decide o que conta como recusa,
 * e a regra é a mesma do componente abaixo. Escrever `data-recusa="permissao"`
 * à mão em vinte lugares seria a lista paralela de novo — e a que ficasse para
 * trás deixaria a guarda verde sobre uma tela que abre para quem não devia.
 */
export const marcaDaRecusa = (code: string) =>
  code === 'forbidden' ? ({ 'data-recusa': 'permissao' } as const) : {};

export function FalhaDaLeitura({
  code,
  oque,
  href,
  className = '',
  parcial = false,
}: {
  /** O código que voltou da API. `forbidden` é o único tratado à parte. */
  readonly code: string;
  /**
   * O que não carregou, com artigo e no meio da frase: "as chaves".
   *
   * Sem preposição escrita aqui: a frase da recusa é "não abre {oque}" e a da
   * falha é "não deu para carregar {oque}". A primeira versão dizia "acesso a
   * {oque}" e saiu na tela como *"acesso a o plano"*.
   */
  readonly oque: string;
  /** Para onde aponta o "tentar de novo" — a própria tela. */
  readonly href: string;
  /** Espaçamento de quem chama, quando o alerta não é a tela inteira. */
  readonly className?: string;
  /**
   * A recusa é de um **pedaço** da tela, não dela inteira.
   *
   * Muda uma coisa só: não desenha a volta. "Voltar ao dia" embaixo de uma
   * seção, numa tela que abriu e funciona, é um botão de saída para quem não
   * está preso — e ensina que aquele botão não quer dizer nada.
   */
  readonly parcial?: boolean;
}) {
  if (code === 'forbidden') {
    return (
      <div className={`ui-alert ui-alert--warning ${className}`} role="alert" {...marcaDaRecusa(code)}>
        Sua conta não abre {oque}. Quem libera é quem administra a conta desta barbearia.
        {/*
          A volta, com o mesmo nome das outras vinte telas que já recusavam.
          Uma tela sem saída é a §6 pergunta 1, e "Voltar ao dia" é o que o
          resto do painel diz — dois nomes para o mesmo gesto é a pergunta 2.
        */}
        {parcial ? null : (
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">
            Voltar ao dia
          </a>
        )}
      </div>
    );
  }

  return (
    <div className={`ui-alert ui-alert--danger ${className}`} role="alert">
      Não deu para carregar {oque}. <a href={href}>Tentar de novo</a>
    </div>
  );
}
