import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { MINIMO_PARA_COMPARAR_REDE } from '@barbearia/core';
import {
  meuLugarNaApi,
  metasDaRedeNaApi,
  redeConsolidadaNaApi,
  type LinhaDaRedeNaApi,
} from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoSair, acaoSalvarMetaDaRede } from '../acoes';
import { secao } from '../secoes';

/**
 * Indicadores consolidados da rede (bloco 77).
 *
 * ## Duas telas com o mesmo endereço, e a diferença é quem você é
 *
 * A **franqueadora** vê a rede nomeada, com o progresso da meta de cada
 * franqueada. É o contrato de franquia funcionando: royalty é percentual sobre
 * receita, e a Lei 13.966/2019 obriga a franqueadora a declarar isso na COF.
 *
 * A **franqueada** vê os próprios números e a mediana da rede, sem nome nenhum.
 * É o mesmo princípio do indicador do barbeiro (SPEC §4.21), que se compara com
 * o próprio passado e não com o colega — e aqui pesa mais, porque as partes são
 * empresas concorrentes entre si dentro da mesma marca.
 *
 * Quem decide qual das duas aparece não é esta tela: é a função `SECURITY
 * DEFINER` no banco, que redige a identidade antes de o dado sair. Aqui a
 * escolha é só de layout.
 */

export const metadata: Metadata = {
  title: 'A rede',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const reais = (centavos: number | null): string =>
  centavos === null
    ? '—'
    : (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const pct = (bps: number | null): string =>
  bps === null ? '—' : `${(bps / 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`;

/** Primeiro e último dia do mês corrente, no formato que a API espera. */
function mesCorrente(hoje: Date): { de: string; ate: string; mes: string } {
  const ano = hoje.getUTCFullYear();
  const mes = hoje.getUTCMonth();
  const dois = (n: number) => String(n).padStart(2, '0');
  const primeiro = `${ano}-${dois(mes + 1)}-01`;
  const ultimo = new Date(Date.UTC(ano, mes + 1, 0));
  return {
    de: primeiro,
    ate: `${ultimo.getUTCFullYear()}-${dois(ultimo.getUTCMonth() + 1)}-${dois(ultimo.getUTCDate())}`,
    mes: primeiro,
  };
}

function Numero({
  rotulo,
  valor,
  nota,
}: {
  readonly rotulo: string;
  readonly valor: string;
  readonly nota?: string | undefined;
}) {
  return (
    <div className="rede-numero">
      <span className="rede-numero__rotulo">{rotulo}</span>
      <strong className="rede-numero__valor tabular">{valor}</strong>
      {nota ? <span className="rede-numero__nota">{nota}</span> : null}
    </div>
  );
}

function Linha({ linha }: { readonly linha: LinhaDaRedeNaApi }) {
  return (
    <tr>
      <td>{linha.nome ?? '—'}</td>
      <td className="tabular">{reais(linha.receitaCents)}</td>
      <td className="tabular">{linha.vendas}</td>
      <td className="tabular">{reais(linha.ticketMedioCents)}</td>
      <td className="tabular">{reais(linha.metaCents)}</td>
      <td className="tabular">
        {linha.progressoBps === null ? (
          /* Sem meta é diferente de zero por cento: a tela não acusa quem não
             foi cobrado de nada. */
          <span className="rede-sem-meta">sem meta</span>
        ) : (
          pct(linha.progressoBps)
        )}
      </td>
    </tr>
  );
}

export default async function RedePage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  // Guarda a sessão e desvia quem não pode — o nome da casa não é usado aqui,
  // porque o topo volta para Franquia e não para o painel.
  await painelOuDesvio(token);
  const query = await searchParams;
  const salvou = first(query['meta']) === '1';

  const janela = mesCorrente(new Date());
  const [consolidado, lugar, metas] = await Promise.all([
    redeConsolidadaNaApi(token, janela.de, janela.ate),
    meuLugarNaApi(token, janela.de, janela.ate),
    metasDaRedeNaApi(token, janela.mes),
  ]);

  const topo = (
    <header className="painel__topo">
      <a className="painel__marca" href="/admin/franquia">
        ← Franquia
      </a>
      <form action={acaoSair}>
        <button className="ui-button ui-button--ghost painel__sair" type="submit">
          Sair
        </button>
      </form>
    </header>
  );

  const mesPorExtenso = new Date(`${janela.de}T12:00:00Z`).toLocaleDateString('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  /**
   * Nenhuma das duas leituras respondeu: esta barbearia não é de franquia.
   *
   * Estado vazio desenhado, com para onde ir — e não uma tabela sem linhas.
   */
  if (!consolidado.ok && !lugar.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('franquia')}>
        {topo}
        <h1 className="painel__titulo">A rede</h1>
        <p className="painel__sub">
          Esta barbearia não faz parte de uma franquia, então não há rede para comparar.
        </p>
        <div className="quadro padrao-vazio">
          <p>
            Os números da casa continuam em <a href="/admin/dre">Resultado</a> e em{' '}
            <a href="/admin/painel">Painel</a>.
          </p>
        </div>
      </main>
    );
  }

  const souFranqueadora = consolidado.ok;
  const rede = consolidado.ok ? consolidado.dados.rede : null;
  const meu = lugar.ok ? lugar.dados.lugar : null;
  const listaDeMetas = metas.ok ? metas.dados.metas : [];

  return (
    <main className="ui-container painel__conteudo" {...secao('franquia')}>
      {topo}

      <h1 className="painel__titulo">A rede em {mesPorExtenso}</h1>
      <p className="painel__sub">
        {souFranqueadora
          ? 'Faturamento de cada franqueada no mês, e o quanto cada uma andou da meta combinada.'
          : 'Seus números do mês, e onde eles ficam na rede. A comparação é sem nome: cada franqueada é uma empresa.'}
      </p>

      {salvou ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Meta combinada.
        </div>
      ) : null}

      {rede ? (
        <>
          <section className="painel__grupo">
            <div className="rede-numeros">
              <Numero rotulo="Faturamento da rede" valor={reais(rede.receitaTotalCents)} />
              <Numero
                rotulo="Ticket médio"
                valor={reais(rede.ticketMedioCents)}
                nota={`${rede.vendasTotais} vendas`}
              />
              <Numero
                rotulo="Mediana por unidade"
                valor={reais(rede.medianaDaReceitaCents)}
                nota={
                  rede.medianaDaReceitaCents === null
                    ? `a partir de ${MINIMO_PARA_COMPARAR_REDE} franqueadas`
                    : undefined
                }
              />
              <Numero
                rotulo="Bateram a meta"
                valor={rede.bateramAMeta === null ? '—' : String(rede.bateramAMeta)}
                nota={rede.bateramAMeta === null ? 'nenhuma meta combinada' : undefined}
              />
            </div>
          </section>

          <section className="painel__grupo">
            <h2 className="painel__secao">Cada franqueada</h2>
            {rede.linhas.length === 0 ? (
              <p className="plano__vazio">
                A rede ainda não tem franqueadas. Pôr uma barbearia na rede é feito pelo suporte,
                porque liga duas empresas diferentes.
              </p>
            ) : (
              <div className="ui-scroll-x">
                <table className="plano-faturas">
                  <thead>
                    <tr>
                      <th scope="col">Franqueada</th>
                      <th scope="col">Faturamento</th>
                      <th scope="col">Vendas</th>
                      <th scope="col">Ticket</th>
                      <th scope="col">Meta</th>
                      <th scope="col">Andou</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rede.linhas.map((l) => (
                      <Linha key={l.tenantId ?? l.nome} linha={l} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="painel__grupo">
            <h2 className="painel__secao">Combinar a meta do mês</h2>
            <p className="plano__nota">
              A meta é do mês e não se renova sozinha — a do mês passado aparece ao lado para
              sugerir, nunca para decidir. Meta é alvo de vendas, e é o que o contrato de franquia
              combina; o preço de cada serviço continua sendo de quem vende.
            </p>
            {listaDeMetas.map((m) => (
              <form action={acaoSalvarMetaDaRede} className="rede-meta" key={m.tenantId}>
                <input name="franqueadaId" type="hidden" value={m.tenantId} />
                <input name="mes" type="hidden" value={m.mes} />
                <div className="ui-field">
                  <label className="ui-field__label" htmlFor={`meta-${m.tenantId}`}>
                    {m.nome}
                  </label>
                  <input
                    className="ui-field__input"
                    defaultValue={m.metaCents === null ? '' : (m.metaCents / 100).toFixed(2)}
                    id={`meta-${m.tenantId}`}
                    inputMode="decimal"
                    name="meta"
                    placeholder={
                      m.anteriorCents === null
                        ? 'ex.: 20000,00'
                        : `mês passado: ${(m.anteriorCents / 100).toFixed(2)}`
                    }
                    required
                    type="text"
                  />
                </div>
                <button className="ui-button ui-button--ghost rede-meta__acao" type="submit">
                  Combinar
                </button>
              </form>
            ))}
          </section>
        </>
      ) : null}

      {meu && !souFranqueadora ? (
        <>
          <section className="painel__grupo">
            <div className="rede-numeros">
              <Numero rotulo="Seu faturamento" valor={reais(meu.minha.receitaCents)} />
              <Numero
                rotulo="Seu ticket médio"
                valor={reais(meu.minha.ticketMedioCents)}
                nota={`${meu.minha.vendas} vendas`}
              />
              <Numero
                rotulo="Mediana da rede"
                valor={reais(meu.medianaDaReceitaCents)}
                nota={
                  meu.medianaDaReceitaCents === null
                    ? `a partir de ${MINIMO_PARA_COMPARAR_REDE} franqueadas`
                    : undefined
                }
              />
              <Numero
                rotulo="Sua meta"
                valor={reais(meu.minha.metaCents)}
                nota={
                  meu.minha.progressoBps === null
                    ? 'nenhuma combinada'
                    : `${pct(meu.minha.progressoBps)} feito`
                }
              />
            </div>
          </section>

          <section className="painel__grupo">
            <h2 className="painel__secao">Onde você está</h2>
            {meu.percentil === null ? (
              <p className="plano__vazio">
                A rede ainda é pequena demais para comparar sem dizer de quem é cada número. A
                partir de {MINIMO_PARA_COMPARAR_REDE} franqueadas esta linha aparece.
              </p>
            ) : (
              <p className="rede-lugar">
                Você fatura mais que{' '}
                <strong className="tabular">{meu.percentil}%</strong> da rede neste mês.
                <span className="rede-lugar__nota">
                  Sem nome, de propósito: cada franqueada é uma empresa, e o faturamento da
                  vizinha é informação comercial dela.
                </span>
              </p>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}
