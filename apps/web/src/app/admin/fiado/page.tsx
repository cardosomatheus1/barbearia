import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { quemDeve, type Devedor } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reaisDoCampo } from '@/lib/dinheiro';
import { acaoReceberFiado, acaoSair } from '../acoes';
import { BalcaoNav } from '../balcao-nav';

/**
 * Quem está devendo.
 *
 * O fiado é a forma de pagamento mais usada em barbearia de bairro e a que o
 * sistema analisado não tinha — o caderno atrás do balcão é o concorrente real
 * desta tela.
 *
 * Ela é uma lista de cobrança, e por isso vem **ordenada pela maior dívida**:
 * a pergunta de quem abre não é "quem deve" mas "de quem eu preciso cobrar".
 */

export const metadata: Metadata = {
  title: 'Fiado',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  pagamento_invalido: 'Confira o valor: não dá para receber mais do que a dívida.',
  cliente_nao_encontrado: 'Este cliente não existe mais.',
  caixa_fechado: 'Abra o caixa antes de receber.',
  valor_invalido: 'Confira o valor: use só números, como 50,00.',
  mfa_required: 'Confirme o código do segundo fator para continuar.',
  forbidden: 'Sua conta não recebe pagamento de fiado.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

const reais = (centavos: number): string => `R$ ${reaisDoCampo(centavos)}`;

function Devendo({ devedor }: { readonly devedor: Devedor }) {
  const divida = -devedor.saldoCents;

  return (
    <li className="devedor">
      <div className="devedor__cabeca">
        <h3 className="devedor__nome">{devedor.name}</h3>
        <span className="devedor__valor">{reais(divida)}</span>
      </div>

      <details className="dobra">
        <summary className="dobra__titulo">Receber</summary>
        <form action={acaoReceberFiado} className="formulario">
          <input name="customerId" type="hidden" value={devedor.id} />

          <div className="ui-field">
            <label className="ui-field__label" htmlFor={`valor-${devedor.id}`}>
              Quanto está pagando
            </label>
            <input
              className="ui-field__input"
              defaultValue={reaisDoCampo(divida)}
              id={`valor-${devedor.id}`}
              inputMode="decimal"
              name="amountCents"
              required
            />
            <p className="ui-field__hint">
              Vem preenchido com a dívida inteira. Pode receber menos — nunca mais, porque
              sobra viraria crédito que ninguém combinou.
            </p>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor={`forma-${devedor.id}`}>
              Como
            </label>
            <select
              className="ui-field__input"
              defaultValue="cash"
              id={`forma-${devedor.id}`}
              name="forma"
            >
              <option value="cash">Dinheiro</option>
              <option value="pix">Pix</option>
              <option value="debit">Débito</option>
              <option value="credit">Crédito</option>
            </select>
          </div>

          <button className="ui-button ui-button--primary ui-button--block" type="submit">
            Receber {reais(divida)}
          </button>
        </form>
      </details>
    </li>
  );
}

export default async function FiadoPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;
  const devedores = await quemDeve(token);

  const erro = first(query['erro']);
  const salvo = first(query['salvo']) === '1';

  const topo = (
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
  );

  if (!devedores.ok) {
    if (devedores.code === 'mfa_required' || devedores.code === 'mfa_setup_required') {
      redirect('/admin/seguranca?de=fiado');
    }
    return (
      <main className="ui-container painel__conteudo">
        {topo}
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[devedores.code] ?? FALHA['request_failed']} <a href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const lista = devedores.dados.devedores;
  const total = lista.reduce((soma, devedor) => soma - devedor.saldoCents, 0);

  return (
    <main className="ui-container painel__conteudo">
      {topo}
      <BalcaoNav atual="/admin/fiado" />

      <h1 className="painel__titulo">Fiado</h1>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Recebido. O valor entrou no caixa e a dívida foi abatida.
        </div>
      ) : null}

      {lista.length === 0 ? (
        <section className="cartao-balcao">
          <h2 className="cartao-balcao__titulo">Ninguém está devendo</h2>
          <p className="cartao-balcao__texto">
            Quando alguém fechar a comanda com fiado, o nome aparece aqui até pagar. O limite de
            cada cliente fica no cadastro dele, e o padrão é <strong>não fiar</strong> — fiar é
            decisão de confiança, uma por pessoa.
          </p>
        </section>
      ) : (
        <>
          <section className="gaveta">
            <p className="gaveta__rotulo">Total a receber</p>
            <p className="gaveta__valor">{reais(total)}</p>
            <p className="gaveta__quem">
              {lista.length === 1 ? '1 pessoa' : `${lista.length} pessoas`}
            </p>
          </section>

          <ul className="devedores">
            {lista.map((devedor) => (
              <Devendo devedor={devedor} key={devedor.id} />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
