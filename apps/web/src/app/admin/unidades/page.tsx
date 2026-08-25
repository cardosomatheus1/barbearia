import { redirect } from 'next/navigation';
import { FUSOS_DO_BRASIL } from '@barbearia/core';
import type { Metadata } from 'next';
import {
  cadastroDeUnidadesNaApi,
  equipePorUnidadeNaApi,
  transferenciasNaApi,
  unidadesNaApi,
  type TransferenciaNaTelaDoAdmin,
  type UnidadeNaTelaDoAdmin,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import {
  acaoAbrirUnidade,
  acaoDefinirUnidadeAtiva,
  acaoDefinirUnidadesDaConta,
  acaoEscolherUnidade,
  acaoSair,
  acaoTransferirEstoque,
} from '../acoes';
import { secao } from '../secoes';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';

/**
 * Unidades (bloco 58, SPEC §1.1 e §1.3).
 *
 * ## Três perguntas, uma tela
 *
 * *Em qual loja eu estou?*, *quem administra qual?* e *como mando produto de uma
 * para a outra?* são a mesma conversa, e separá-las em três telas faria a
 * segunda e a terceira nunca serem encontradas — o gestor entra aqui pela
 * primeira, que é a que ele usa todo dia.
 *
 * ## A barbearia de uma loja só não vê quase nada
 *
 * É o caso de toda barbearia até aqui. Sem uma segunda unidade não há o que
 * escolher, não há para onde transferir e não há o que recortar: a tela diz isso
 * em uma frase e some do caminho. Um seletor de uma opção só e uma tabela de
 * transferências sempre vazia seriam ruído permanente para quem nunca vai abrir
 * a segunda loja.
 *
 * ## Nenhuma caixa marcada significa **todas**
 *
 * É o contrário da leitura óbvia, e por isso está escrito na tela e não só no
 * schema. Negar por omissão seria o padrão natural de qualquer outro campo — e
 * aqui trancaria a equipe inteira para fora no dia em que este bloco entrasse.
 */

export const metadata: Metadata = {
  title: 'Unidades',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  unidade_nao_encontrada: 'Esta unidade não existe ou não é sua.',
  unidade_fechada: 'Esta unidade está fechada.',
  saldo_insuficiente: 'A loja de origem não tem essa quantidade.',
  mesma_unidade: 'Escolha duas lojas diferentes.',
  quantidade_invalida: 'A quantidade precisa ser maior que zero.',
  owner_protected: 'O dono opera todas as unidades, e isso não se edita.',
  ultima_unidade: 'Esta é a única unidade aberta. A barbearia precisa de uma.',
  location_not_found: 'Esta unidade não existe.',
  invalid_location: 'Confira o nome da unidade.',
  cannot_grant: 'Você não administra essa unidade.',
  unknown_location: 'Esta unidade não existe ou não é sua.',
  forbidden: 'Sua conta não faz isso.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

const FEITO: Record<string, string> = {
  unidade: 'Pronto. Você está operando nesta unidade.',
  aberta: 'Unidade aberta. Configure a jornada dos profissionais dela em Profissionais.',
  fechada: 'Unidade fechada. O histórico dela continua nos relatórios.',
  reaberta: 'Unidade reaberta.',
  equipe: 'Vínculo salvo.',
  transferencia: 'Produto transferido. As duas lojas já mostram o saldo novo.',
};

const PAPEL: Record<string, string> = {
  owner: 'Dono',
  manager: 'Gerente',
  receptionist: 'Recepção',
  professional: 'Barbeiro',
};

const quando = (iso: string, timezone: string): string =>
  new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(iso));

function Transferencia({
  linha,
  timezone,
}: {
  readonly linha: TransferenciaNaTelaDoAdmin;
  readonly timezone: string;
}) {
  return (
    <li>
      <article className="item-cadastro">
        <div className="item-cadastro__cabeca">
          <div className="item-cadastro__quem">
            <h3 className="item-cadastro__nome">
              {linha.quantidade}× {linha.produto}
            </h3>
            <p className="item-cadastro__linha">
              {linha.deNome} → {linha.paraNome}
            </p>
            <p className="item-cadastro__linha">
              {quando(linha.quando, timezone)} · {linha.quem}
              {linha.nota ? ` · ${linha.nota}` : ''}
            </p>
          </div>
        </div>
      </article>
    </li>
  );
}

export default async function UnidadesPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;

  const podeCadastrar = podeNaTela(estado, 'settings.manage');
  const podeEquipe = podeNaTela(estado, 'team.manage') && podeCadastrar;
  const podeEstoque = podeNaTela(estado, 'inventory.adjust');

  const selecao = await unidadesNaApi(token);
  const atual = selecao.ok ? selecao.dados.atual : null;
  const disponiveis: readonly UnidadeNaTelaDoAdmin[] = selecao.ok ? selecao.dados.disponiveis : [];
  const abertas = disponiveis.filter((u) => u.ativa);
  const rede = abertas.length > 1;

  const cadastro = podeCadastrar ? await cadastroDeUnidadesNaApi(token) : null;
  /**
   * A mesma condição que o domínio usa para recusar `ultima_unidade`: a
   * barbearia precisa de pelo menos uma loja aberta.
   */
  const unicaAberta =
    cadastro?.ok === true && cadastro.dados.unidades.filter((u) => u.ativa).length === 1;
  const equipe = podeEquipe && rede ? await equipePorUnidadeNaApi(token) : null;
  const estoque = podeEstoque && rede ? await transferenciasNaApi(token) : null;

  const erro = first(query['erro']);
  const feito = first(query['feito']);
  const timezone = atual?.timezone ?? 'America/Sao_Paulo';

  const saldoEm = (produtoId: string, unidadeId: string): number =>
    estoque?.ok
      ? (estoque.dados.saldos.find((s) => s.produtoId === produtoId && s.unidadeId === unidadeId)
          ?.saldo ?? 0)
      : 0;

  return (
    <main className="ui-container painel__conteudo" {...secao('unidades')}>
      <header className="painel__topo">
        <a className="painel__marca" href="/admin/dia">
          ← {estado.businessName}
        </a>
        <form action={acaoSair}>
          <button className="ui-button ui-button--ghost painel__sair" type="submit">
            Sair
          </button>
        </form>
      </header>

      <h1 className="painel__titulo">Unidades</h1>
      <p className="painel__sub">
        Em qual loja o balcão está, quem administra cada uma e como mandar produto de uma para a
        outra.
      </p>

      {erro ? (
        <AvisoDeRecusa erro={erro} mapa={FALHA} className="painel__aviso" />
      ) : null}
      {feito ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          {FEITO[feito] ?? 'Pronto.'}
        </div>
      ) : null}

      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">Onde você está</h2>
        {atual ? (
          <p className="unidade-atual">{atual.nome}</p>
        ) : (
          <p className="cartao-balcao__texto">
            {selecao.ok && selecao.dados.falha
              ? selecao.dados.falha
              : 'Nenhuma unidade disponível para a sua conta.'}
          </p>
        )}

        {rede ? (
          <>
            <p className="cartao-balcao__texto">
              Caixa, comanda e agenda são desta loja. Trocar aqui troca em todas as telas.
            </p>
            <ul className="lista-cadastro">
              {abertas.map((unidade) => (
                <li key={unidade.id}>
                  <form action={acaoEscolherUnidade} className="unidade-linha">
                    <input name="unidadeId" type="hidden" value={unidade.id} />
                    <input name="de" type="hidden" value="/admin/unidades" />
                    <span className="unidade-linha__nome">{unidade.nome}</span>
                    <button
                      className={`ui-button ${
                        unidade.id === atual?.id ? 'ui-button--ghost' : 'ui-button--primary'
                      }`}
                      disabled={unidade.id === atual?.id}
                      type="submit"
                    >
                      {unidade.id === atual?.id ? 'Aqui' : 'Ir para esta'}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </>
        ) : (
          /* Estado vazio desenhado, e não uma lista de um item: enquanto há uma
             loja só, escolher não é uma decisão que exista. */
          <p className="cartao-balcao__texto">
            Esta barbearia tem uma unidade. Quando abrir a segunda, a escolha da loja e a
            transferência de estoque aparecem aqui.
          </p>
        )}
      </section>

      {podeCadastrar ? (
        <section className="cartao-balcao">
          <h2 className="cartao-balcao__titulo">As lojas da casa</h2>
          <p className="cartao-balcao__texto">
            Unidade fecha, não some: a loja encerrada sai da escolha do balcão e o histórico dela
            continua nos relatórios.
          </p>

          {cadastro?.ok ? (
            <ul className="lista-cadastro">
              {cadastro.dados.unidades.map((unidade) => (
                <li key={unidade.id}>
                  <form action={acaoDefinirUnidadeAtiva} className="unidade-linha">
                    <input name="unidadeId" type="hidden" value={unidade.id} />
                    <input name="ativa" type="hidden" value={unidade.ativa ? 'nao' : 'sim'} />
                    <span className="unidade-linha__nome">
                      {unidade.nome}
                      {unidade.cidade ? ` · ${unidade.cidade}` : ''}
                      {unidade.ativa ? '' : ' · fechada'}
                      {/* Fechar a loja em que se está é permitido e derruba a
                          própria escolha — quem faz isso precisa saber antes,
                          não descobrir na tela seguinte. */}
                      {unidade.ativa && unidade.id === atual?.id
                        ? ' · você está operando aqui'
                        : ''}
                    </span>
                    {/*
                      O botão sai da mesma pergunta que o domínio faz (bloco 104).

                      Na barbearia de uma loja — que o cartão acima descreve em
                      letras — "Fechar" aparecia e o domínio recusava com
                      `ultima_unidade`, sempre. Derivado de "existe unidade?" em
                      vez de "esta pode fechar?", era um botão que só sabia
                      falhar.
                    */}
                    {unidade.ativa && unicaAberta ? (
                      <span className="unidade-linha__nota">
                        única aberta — a barbearia precisa de uma
                      </span>
                    ) : (
                      <button className="ui-button ui-button--ghost" type="submit">
                        {unidade.ativa ? 'Fechar' : 'Reabrir'}
                      </button>
                    )}
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="cartao-balcao__texto">Não deu para carregar as unidades agora.</p>
          )}

          <h3 className="cartao-balcao__titulo">Abrir outra loja</h3>
          <form action={acaoAbrirUnidade} className="formulario">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="nome">
                Nome da unidade
              </label>
              <input
                className="ui-field__input"
                id="nome"
                maxLength={120}
                minLength={2}
                name="nome"
                placeholder="Domari Pituba"
                required
              />
            </div>

            <div className="campos-lado">
              <div className="ui-field">
                <label className="ui-field__label" htmlFor="cidade">
                  Cidade
                </label>
                <input
                  className="ui-field__input"
                  id="cidade"
                  maxLength={80}
                  name="cidade"
                  placeholder="Salvador"
                />
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="estado">
                  UF
                </label>
                <input
                  className="ui-field__input"
                  id="estado"
                  maxLength={2}
                  minLength={2}
                  name="estado"
                  placeholder="BA"
                />
                <p className="ui-field__hint">Ajuda a posicionar a unidade na busca quando não há link do mapa.</p>
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="timezone">
                  Fuso da loja
                </label>
                <select
                  className="ui-field__input"
                  defaultValue={atual?.timezone ?? 'America/Sao_Paulo'}
                  id="timezone"
                  name="timezone"
                >
                  {FUSOS_DO_BRASIL.map((fuso) => (
                    <option key={fuso.id} value={fuso.id}>
                      {fuso.rotulo}
                    </option>
                  ))}
                </select>
                {/* O fuso decide o dia da venda, e uma rede com loja em Salvador
                    e em Rio Branco tem dois "hoje" diferentes. */}
                <p className="ui-field__hint">
                  É ele que decide de que dia é o dinheiro da loja, no fechamento do caixa.
                </p>
              </div>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="linkDoMapa">
                Link do mapa
              </label>
              <input
                className="ui-field__input"
                id="linkDoMapa"
                maxLength={500}
                name="linkDoMapa"
                placeholder="Cole o link da unidade no Google Maps"
              />
              <p className="ui-field__hint">O ponto exato faz esta unidade aparecer corretamente na busca e no mapa do cliente.</p>
            </div>

            <button className="ui-button ui-button--ghost" type="submit">
              Abrir unidade
            </button>
          </form>
        </section>
      ) : null}

      {podeEquipe && rede ? (
        <section className="cartao-balcao">
          <h2 className="cartao-balcao__titulo">Quem administra qual loja</h2>
          <p className="cartao-balcao__texto">
            Nenhuma marcada significa <strong>todas as unidades</strong>. O que cada pessoa pode
            fazer continua saindo do papel dela — isto decide só onde.
          </p>
          {equipe?.ok ? (
            <ul className="lista-cadastro">
              {equipe.dados.equipe.map((pessoa) => (
                <li key={pessoa.id}>
                  <form action={acaoDefinirUnidadesDaConta} className="formulario unidade-vinculo">
                    <input name="staffUserId" type="hidden" value={pessoa.id} />
                    <h3 className="item-cadastro__nome">{pessoa.nome}</h3>
                    <p className="item-cadastro__linha">
                      {PAPEL[pessoa.papel] ?? pessoa.papel}
                      {pessoa.unidades.length === 0 ? ' · todas as unidades' : ''}
                    </p>
                    {pessoa.papel === 'owner' ? (
                      <p className="ui-field__hint">
                        O dono opera todas as unidades, e isso não se edita.
                      </p>
                    ) : (
                      <>
                        {equipe.dados.unidades.map((unidade) => (
                          <div className="ui-field" key={unidade.id}>
                            <label
                              className="ui-field__label"
                              htmlFor={`u-${pessoa.id}-${unidade.id}`}
                            >
                              <input
                                defaultChecked={pessoa.unidades.includes(unidade.id)}
                                id={`u-${pessoa.id}-${unidade.id}`}
                                name="unidade"
                                type="checkbox"
                                value={unidade.id}
                              />{' '}
                              {unidade.nome}
                              {unidade.ativa ? '' : ' (fechada)'}
                            </label>
                          </div>
                        ))}
                        <button className="ui-button ui-button--ghost" type="submit">
                          Salvar unidades
                        </button>
                      </>
                    )}
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="cartao-balcao__texto">Não deu para carregar a equipe agora.</p>
          )}
        </section>
      ) : null}

      {podeEstoque && rede && estoque?.ok ? (
        <section className="cartao-balcao">
          <h2 className="cartao-balcao__titulo">Mandar produto para outra loja</h2>
          <p className="cartao-balcao__texto">
            O produto sai pelo custo que tinha na loja de origem. Transferir não muda a margem de
            nenhuma das duas.
          </p>

          {estoque.dados.produtos.length === 0 ? (
            <p className="cartao-balcao__texto">
              Nenhum produto cadastrado ainda. O cadastro fica em Estoque.
            </p>
          ) : (
            <form action={acaoTransferirEstoque} className="formulario">
              <div className="ui-field">
                <label className="ui-field__label" htmlFor="produtoId">
                  Produto
                </label>
                <select className="ui-field__input" id="produtoId" name="produtoId" required>
                  {estoque.dados.produtos.map((produto) => (
                    <option key={produto.id} value={produto.id}>
                      {produto.nome} — {produto.saldo} na rede
                    </option>
                  ))}
                </select>
              </div>

              <div className="campos-lado">
                <div className="ui-field">
                  <label className="ui-field__label" htmlFor="origemId">
                    De
                  </label>
                  <select
                    className="ui-field__input"
                    defaultValue={atual?.id ?? ''}
                    id="origemId"
                    name="origemId"
                    required
                  >
                    {estoque.dados.unidades.map((unidade) => (
                      <option key={unidade.id} value={unidade.id}>
                        {unidade.nome}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="ui-field">
                  <label className="ui-field__label" htmlFor="destinoId">
                    Para
                  </label>
                  <select className="ui-field__input" id="destinoId" name="destinoId" required>
                    {estoque.dados.unidades.map((unidade) => (
                      <option key={unidade.id} value={unidade.id}>
                        {unidade.nome}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="quantidade">
                  Quantas unidades
                </label>
                <input
                  className="ui-field__input"
                  id="quantidade"
                  inputMode="numeric"
                  min={1}
                  name="quantidade"
                  required
                  type="number"
                />
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="nota">
                  Por quê (opcional)
                </label>
                <input
                  className="ui-field__input"
                  id="nota"
                  maxLength={240}
                  name="nota"
                  placeholder="reposição de sexta"
                />
              </div>

              {/* `ghost`, e não `accent`: a ação primária desta tela é trocar
                  de loja, que é o que a recepção faz ao chegar. Três botões em
                  destaque em três cartões seria a tela dizendo que tudo importa
                  igual. */}
              <button className="ui-button ui-button--ghost" type="submit">
                Transferir
              </button>
            </form>
          )}

          <h3 className="cartao-balcao__titulo">O que já foi de uma loja para a outra</h3>
          {estoque.dados.transferencias.length === 0 ? (
            <p className="cartao-balcao__texto">
              Nenhuma transferência ainda. A primeira aparece aqui, com quem mandou e por quê.
            </p>
          ) : (
            <ul className="lista-cadastro">
              {estoque.dados.transferencias.map((linha) => (
                <Transferencia key={linha.id} linha={linha} timezone={timezone} />
              ))}
            </ul>
          )}

          <h3 className="cartao-balcao__titulo">Quanto tem em cada loja</h3>
          {/* A tabela rola dentro do próprio recipiente: com quatro lojas ela
              estoura 360px, e sem isto levaria a página junto. */}
          <div className="ui-scroll-x">
            <table className="unidades-saldos">
              <thead>
                <tr>
                  <th scope="col">Produto</th>
                  {estoque.dados.unidades.map((unidade) => (
                    <th key={unidade.id} scope="col">
                      {unidade.nome}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {estoque.dados.produtos.map((produto) => (
                  <tr key={produto.id}>
                    <th scope="row">{produto.nome}</th>
                    {estoque.dados.unidades.map((unidade) => (
                      <td key={unidade.id}>{saldoEm(produto.id, unidade.id)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </main>
  );
}
