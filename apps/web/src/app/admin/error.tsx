'use client';

/**
 * Última rede de recuperação dentro do painel.
 *
 * A borda não promete que a ação anterior falhou: se a conexão caiu depois de
 * o servidor gravar e antes da resposta chegar, repetir cegamente pode duplicar
 * uma operação que não seja idempotente. Por isso a orientação é conferir o
 * estado antes de repetir qualquer lançamento.
 */
export default function AdminError({ reset }: { readonly reset: () => void }) {
  return (
    <main className="ui-container painel__conteudo" id="conteudo-principal">
      <section className="cartao-balcao" role="alert" aria-labelledby="falha-titulo">
        <p className="painel__sobretitulo">A tela foi interrompida</p>
        <h1 className="painel__titulo" id="falha-titulo">Não foi possível concluir esta tela</h1>
        <p className="cartao-balcao__texto">
          Se você acabou de salvar, cobrar ou fechar alguma coisa, confira o resultado antes de
          repetir a operação. A gravação pode ter terminado mesmo que a resposta não tenha voltado.
        </p>
        <div className="painel__acoes">
          <button className="ui-button ui-button--primary" onClick={reset} type="button">
            Tentar abrir de novo
          </button>
          <a className="ui-button ui-button--secondary" href="/admin/dia">
            Voltar para Hoje
          </a>
        </div>
      </section>
    </main>
  );
}
