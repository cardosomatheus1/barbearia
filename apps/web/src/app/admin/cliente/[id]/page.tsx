import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { CONVERSAS, destaquesDaFicha, fichaEstaVazia, fraseDaConversa } from '@barbearia/core';
import { fichaDoCliente, type VisitaNaFicha } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoPreferencias, acaoSair } from '../../acoes';

/**
 * A ficha do cliente — SPEC §4.1 e §4.3.
 *
 * "A tela que o barbeiro abre antes de atender." Ela responde duas perguntas
 * na ordem em que elas aparecem na cadeira: **como esta pessoa gosta de ser
 * atendida** e **como ela vem sendo atendida**.
 *
 * O que evitar vem primeiro apesar de ser o campo menos preenchido. É o único
 * cuja falha machuca: alergia a pós-barba com álcool lida depois da navalha não
 * serviu para nada.
 *
 * A anotação aparece com **quem escreveu e quando**. Ninguém confia numa
 * anotação sem dono — "não usar navalha" escrito por quem saiu há dois anos
 * vale menos que o de ontem, e é o barbeiro quem decide isso, não a tela.
 */

export const metadata: Metadata = {
  title: 'Ficha do cliente',
  robots: { index: false, follow: false },
};

interface Props {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  cliente_nao_encontrado: 'Este cliente não existe mais.',
  preferencia_invalida: 'Escolha uma das opções de conversa.',
  forbidden: 'Sua conta não vê as anotações dos clientes.',
  invalid_request: 'Confira os campos: alguma anotação ficou longa demais.',
  request_failed: 'Não deu para carregar. Tente de novo.',
};

const ROTULO_DA_VISITA: Record<string, string> = {
  completed: 'Atendido',
  no_show: 'Faltou',
  cancelled_customer: 'Cancelou',
  cancelled_business: 'Cancelado pela casa',
};

const ROTULO_DA_CONVERSA: Record<string, string> = {
  silencioso: 'Silêncio',
  indiferente: 'Tanto faz',
  conversa: 'Conversa',
};

const dinheiro = (centavos: number): string =>
  `R$ ${(centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

function dia(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
    .format(new Date(iso));
}

function Visita({ visita }: { readonly visita: VisitaNaFicha }) {
  const veio = visita.status === 'completed';
  return (
    <li className={`visita${veio ? '' : ' visita--falhou'}`}>
      <span className="visita__quando tabular">{dia(visita.quando)}</span>
      <span className="visita__servico">
        {veio ? visita.servicos.join(' + ') || 'Atendimento' : ROTULO_DA_VISITA[visita.status]}
      </span>
      <span className="visita__quem">{visita.profissional}</span>
      {veio ? <span className="visita__valor tabular">{dinheiro(visita.precoCents)}</span> : null}
    </li>
  );
}

export default async function FichaPage({ params, searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const { id } = await params;
  const query = await searchParams;
  const erro = first(query['erro']);
  const salvo = first(query['salvo']) === '1';
  // Só dois destinos, e conferidos: valor de query virando `href` de volta é o
  // mesmo buraco de um `redirect` cru com entrada externa.
  const voltar = first(query['de']) === 'meu-dia' ? '/admin/meu-dia' : '/admin/dia';

  const ficha = await fichaDoCliente(token, id);

  const topo = (
    <header className="painel__topo">
      <a className="painel__marca" href={voltar}>
        ← {estado.businessName}
      </a>
      <form action={acaoSair}>
        <button className="ui-button ui-button--ghost painel__sair" type="submit">
          Sair
        </button>
      </form>
    </header>
  );

  if (!ficha.ok) {
    return (
      <main className="ui-container painel__conteudo">
        {topo}
        <h1 className="painel__titulo">Ficha</h1>
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[ficha.code] ?? FALHA['request_failed']}
          <a className="ui-button ui-button--secondary painel__saida" href={voltar}>
            Voltar
          </a>
        </div>
      </main>
    );
  }

  const { preferencias, linhaDoTempo } = ficha.dados;
  const destaques = destaquesDaFicha(preferencias);
  const conversa = fraseDaConversa(preferencias.conversa);
  const vazia = fichaEstaVazia(preferencias);

  return (
    <main className="ui-container painel__conteudo">
      {topo}

      <h1 className="painel__titulo">{ficha.dados.nome}</h1>
      <p className="painel__sub">
        {ficha.dados.visitas === 0
          ? 'Primeira vez aqui'
          : `${ficha.dados.visitas} ${ficha.dados.visitas === 1 ? 'visita' : 'visitas'}`}
        {ficha.dados.desde ? ` · cliente desde ${dia(ficha.dados.desde)}` : ''}
        {` · final ${ficha.dados.telefoneFinal}`}
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Anotação salva.
        </div>
      ) : null}

      {vazia ? (
        <div className="vazio">
          <p className="vazio__titulo">Ninguém anotou nada ainda</p>
          <p className="vazio__saida">
            Escreva o que você descobrir hoje. Da próxima vez — com você ou com outro barbeiro —
            o corte sai certo de primeira.
          </p>
        </div>
      ) : (
        <section className="como-corta">
          {destaques.length > 0 ? (
            <ul className="como-corta__lista">
              {destaques.map((item) => (
                <li className="como-corta__item" key={item.rotulo}>
                  <span className="como-corta__rotulo">{item.rotulo}</span>
                  <span className="como-corta__valor">{item.valor}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {conversa ? <p className="como-corta__conversa">{conversa}</p> : null}
          {preferencias.observacoes ? (
            <p className="como-corta__nota">{preferencias.observacoes}</p>
          ) : null}
          {ficha.dados.anotadoPor ? (
            <p className="como-corta__autor">
              Anotado por {ficha.dados.anotadoPor}
              {ficha.dados.anotadoEm ? ` em ${dia(ficha.dados.anotadoEm)}` : ''}
            </p>
          ) : null}
        </section>
      )}

      <details className="anotar">
        <summary className="anotar__abrir">{vazia ? 'Anotar' : 'Mudar a anotação'}</summary>

        <form action={acaoPreferencias} className="formulario anotar__forma">
          <input name="customerId" type="hidden" value={ficha.dados.customerId} />
          <input name="de" type="hidden" value={voltar} />

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="produtosEvitar">
              O que evitar
            </label>
            <input className="ui-field__input" defaultValue={preferencias.produtosEvitar ?? ''}
                   id="produtosEvitar" maxLength={240} name="produtosEvitar"
                   placeholder="Álcool no pós-barba" type="text" />
            <p className="ui-field__hint">Alergia, produto que irrita, o que já deu errado.</p>
          </div>

          <div className="anotar__dupla">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="maquinaLaterais">Laterais</label>
              <input className="ui-field__input" defaultValue={preferencias.maquinaLaterais ?? ''}
                     id="maquinaLaterais" maxLength={120} name="maquinaLaterais"
                     placeholder="Máquina 1" type="text" />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="tipoDegrade">Degradê</label>
              <input className="ui-field__input" defaultValue={preferencias.tipoDegrade ?? ''}
                     id="tipoDegrade" maxLength={120} name="tipoDegrade"
                     placeholder="Médio" type="text" />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="topo">Topo</label>
              <input className="ui-field__input" defaultValue={preferencias.topo ?? ''}
                     id="topo" maxLength={120} name="topo" placeholder="Tesoura" type="text" />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="barbaEstilo">Barba</label>
              <input className="ui-field__input" defaultValue={preferencias.barbaEstilo ?? ''}
                     id="barbaEstilo" maxLength={120} name="barbaEstilo"
                     placeholder="Aparar, sem navalha" type="text" />
            </div>
          </div>

          <fieldset className="painel__grupo">
            <legend className="ui-field__label">Durante o corte</legend>
            <div className="anotar__conversa">
              {CONVERSAS.map((opcao) => (
                <label className="marca" htmlFor={`conversa-${opcao}`} key={opcao}>
                  <input defaultChecked={preferencias.conversa === opcao}
                         id={`conversa-${opcao}`} name="conversa" type="radio" value={opcao} />
                  <span>{ROTULO_DA_CONVERSA[opcao]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="observacoes">Outras observações</label>
            <textarea className="ui-field__input" defaultValue={preferencias.observacoes ?? ''}
                      id="observacoes" maxLength={1000} name="observacoes" rows={3}
                      placeholder="Redemoinho do lado direito abre para cima" />
          </div>

          <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
            Salvar anotação
          </button>
        </form>
      </details>

      <h2 className="ficha__titulo">Últimas vezes</h2>

      {linhaDoTempo.length === 0 ? (
        <div className="vazio">
          <p className="vazio__titulo">Nenhum atendimento ainda</p>
          <p className="vazio__saida">A primeira vez aparece aqui depois que você terminar.</p>
        </div>
      ) : (
        <ul className="visitas">
          {linhaDoTempo.map((visita) => (
            <Visita key={visita.id} visita={visita} />
          ))}
        </ul>
      )}
    </main>
  );
}
