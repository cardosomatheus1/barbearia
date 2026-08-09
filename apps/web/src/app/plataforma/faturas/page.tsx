import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  faturasEmCobranca,
  listarBarbearias,
  type FaturaNaPlataforma,
} from '@/lib/plataforma-api';
import { lerSessaoDaPlataforma } from '@/lib/sessao-plataforma';
import { acaoAnularFatura, acaoRegistrarPagamento } from '../acoes';

/**
 * A fila de cobrança (bloco 28).
 *
 * É a tela que fecha a régua pelo lado de dentro. A régua emite, avisa, marca
 * vencida, tenta cobrar e suspende — mas até o bloco 29 ligar o PSP, quem
 * **quita** uma fatura é alguém aqui, registrando o pagamento que conferiu no
 * extrato bancário. Sem esta tela a régua só sabe apertar.
 *
 * Ordenada por quem vence primeiro, não por quem deve mais: a pergunta do
 * suporte é "quem vai ser suspenso essa semana", e é o prazo que responde.
 *
 * O nome da barbearia é resolvido aqui a partir da lista, como na trilha e pelo
 * mesmo motivo: o nome muda, o `tenant_id` não.
 */

export const metadata: Metadata = {
  title: 'Cobrança',
  robots: { index: false, follow: false },
};

const reais = (centavos: number): string =>
  `R$ ${(centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

const dia = (iso: string): string =>
  new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

/**
 * Dias de atraso, contra o instante em que a página é montada.
 *
 * Negativo é "ainda não venceu", e a tela diz isso com outras palavras — o
 * número cru mandaria o suporte cobrar quem está em dia.
 */
const atraso = (iso: string): number =>
  Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

/** Os 21 dias de janela vivem em `packages/core`; aqui só se conta o que falta. */
const DIAS_ATE_A_SUSPENSAO = 21;

function Prazo({ f }: { readonly f: FaturaNaPlataforma }) {
  const dias = atraso(f.vencimento);

  if (dias < 0) {
    return <span className="cobranca__prazo">vence em {Math.abs(dias)} d</span>;
  }
  const faltam = Math.max(0, DIAS_ATE_A_SUSPENSAO - dias);
  return (
    <span className={`cobranca__prazo ${faltam <= 5 ? 'cobranca__prazo--critico' : ''}`}>
      {dias} d de atraso · {faltam === 0 ? 'suspensa' : `${faltam} d até suspender`}
    </span>
  );
}

export default async function FaturasDaPlataformaPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ pago?: string; anulada?: string; erro?: string }>;
}) {
  const parametros = await searchParams;
  const token = await lerSessaoDaPlataforma();
  if (!token) redirect('/plataforma/entrar');

  const [cobranca, lista] = await Promise.all([
    faturasEmCobranca(token),
    listarBarbearias(token),
  ]);

  if (!cobranca.ok) {
    if (cobranca.code === 'unauthorized') redirect('/plataforma/entrar');
    return (
      <main className="ui-container painel__conteudo plataforma__trabalho">
        <h1 className="painel__titulo">Cobrança</h1>
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar as faturas. Recarregue a página.
        </div>
      </main>
    );
  }

  const nomes = new Map(
    (lista.ok ? lista.dados.barbearias : []).map((b) => [b.tenantId, b.nome] as const),
  );
  const faturas = cobranca.dados.faturas;
  const total = faturas.reduce((soma, f) => soma + f.valorCents, 0);

  return (
    <main className="ui-container painel__conteudo plataforma__trabalho">
      <h1 className="painel__titulo">Cobrança</h1>
      <p className="painel__sub">
        O que está em aberto, de quem vence primeiro. Registrar o pagamento quita a fatura e
        devolve ao ar quem a régua suspendeu.
      </p>

      {parametros.pago ? (
        <div className="ui-alert ui-alert--success" role="status">
          Pagamento registrado.
        </div>
      ) : null}
      {parametros.anulada ? (
        <div className="ui-alert ui-alert--success" role="status">
          Fatura cancelada. Ela não conta como dinheiro entrado.
        </div>
      ) : null}
      {parametros.erro ? (
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para concluir ({parametros.erro}).
        </div>
      ) : null}

      {faturas.length === 0 ? (
        <div className="vazio">
          <p className="vazio__titulo">Nada em aberto</p>
          <p className="vazio__saida">
            Toda assinatura está em dia. A régua emite a próxima fatura três dias antes de o
            período virar.
          </p>
        </div>
      ) : (
        <>
          <p className="cobranca__total">
            {faturas.length} {faturas.length === 1 ? 'fatura' : 'faturas'} · {reais(total)} em
            aberto
          </p>

          <ul className="cobranca__lista">
            {faturas.map((f) => (
              <li className="cobranca__item" key={f.id}>
                <div className="cobranca__cabeca">
                  <p className="cobranca__barbearia">{nomes.get(f.tenantId) ?? f.tenantId}</p>
                  <p className="cobranca__valor">{reais(f.valorCents)}</p>
                </div>

                <p className="cobranca__sobre">
                  {f.tipo === 'proration' ? 'Acerto de troca de plano' : `Plano ${f.planoCode}`} ·
                  vence {dia(f.vencimento)} · {f.tentativas}{' '}
                  {f.tentativas === 1 ? 'tentativa' : 'tentativas'}
                </p>
                <Prazo f={f} />

                <div className="cobranca__acoes">
                  <form action={acaoRegistrarPagamento} className="cobranca__forma">
                    <input name="faturaId" type="hidden" value={f.id} />
                    <label className="ui-field__label" htmlFor={`metodo-${f.id}`}>
                      Como entrou
                    </label>
                    <select
                      className="ui-field__input cobranca__metodo"
                      defaultValue="manual"
                      id={`metodo-${f.id}`}
                      name="metodo"
                    >
                      <option value="manual">Transferência conferida</option>
                      <option value="pix">Pix</option>
                      <option value="boleto">Boleto</option>
                      <option value="card">Cartão</option>
                    </select>
                    <button className="ui-button ui-button--primary" type="submit">
                      Registrar pagamento
                    </button>
                  </form>

                  <form action={acaoAnularFatura} className="cobranca__forma">
                    <input name="faturaId" type="hidden" value={f.id} />
                    <label className="ui-field__label" htmlFor={`motivo-${f.id}`}>
                      Cancelar, com motivo
                    </label>
                    <input
                      className="ui-field__input"
                      id={`motivo-${f.id}`}
                      maxLength={500}
                      minLength={3}
                      name="motivo"
                      placeholder="Cortesia de migração, erro de emissão…"
                      required
                      type="text"
                    />
                    <button className="ui-button ui-button--ghost" type="submit">
                      Cancelar fatura
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
