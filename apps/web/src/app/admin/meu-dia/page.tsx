import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { recortarMeuDia, fraseDoIntervalo } from '@barbearia/core';
import { painelDoDia, type LinhaDoDia } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoAtendimento, acaoSair } from '../acoes';

/**
 * O dia do barbeiro.
 *
 * A quarta superfície, e a mais estreita de todas. A recepção pergunta "como
 * está o salão?" e precisa de trinta linhas na tela; o barbeiro pergunta **"quem
 * é o próximo e o que ele gosta?"** — de pé, no celular, com a máquina na outra
 * mão e trinta segundos entre um cliente e outro.
 *
 * Três decisões que vêm dessa diferença:
 *
 * - **Um cartão por vez, não uma tabela.** Quem está na cadeira ocupa a tela
 *   inteira; o próximo vem logo abaixo; o resto do dia é uma lista curta. A
 *   densidade do balcão aqui seria ruído: ele não precisa saber o que acontece
 *   na cadeira do colega.
 * - **O tempo até o próximo é a informação principal.** É o que decide se dá
 *   para tomar um café, ir ao banheiro ou nem sentar. Está em texto, grande,
 *   antes de qualquer nome.
 * - **A ficha fica a um toque.** "Máquina 1 nas laterais, não usar navalha" é
 *   a coisa mais valiosa que este sistema entrega (SPEC §4.1), e ela não serve
 *   para nada se o barbeiro precisar procurar.
 *
 * Mesma tela em 360 e em 1280: no notebook ela ganha o dia inteiro ao lado, não
 * vira outra página.
 */

export const metadata: Metadata = {
  title: 'Meu dia',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  transition_not_allowed: 'Esse atendimento já mudou. Puxe a tela de novo.',
  appointment_not_found: 'Esse atendimento não existe mais.',
  forbidden: 'Sua conta não faz isso.',
  request_failed: 'Não deu para carregar. Tente de novo.',
};

const RÓTULO: Partial<Record<LinhaDoDia['status'], string>> = {
  pending: 'Marcado',
  confirmed: 'Confirmado',
  checked_in: 'Chegou',
  waiting: 'Aguardando',
  in_progress: 'Na cadeira',
};

/** O verbo do botão, na ordem da máquina de estados. */
const VERBO: Partial<Record<string, string>> = {
  check_in: 'Chegou',
  start: 'Começar',
  complete: 'Terminei',
  no_show: 'Não veio',
};

/** A ação que o barbeiro faz nesta linha — uma só, a próxima. */
function acaoPrincipal(linha: LinhaDoDia): string | null {
  for (const candidata of ['start', 'complete', 'check_in'] as const) {
    if (linha.actions.includes(candidata)) return candidata;
  }
  return null;
}

function Botao({ linha, acao }: { readonly linha: LinhaDoDia; readonly acao: string }) {
  return (
    <form action={acaoAtendimento}>
      <input name="id" type="hidden" value={linha.id} />
      <input name="action" type="hidden" value={acao} />
      <input name="voltar" type="hidden" value="/admin/meu-dia" />
      <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
        {VERBO[acao] ?? acao}
      </button>
    </form>
  );
}

function Cartao({
  linha,
  destaque,
}: {
  readonly linha: LinhaDoDia;
  readonly destaque?: boolean;
}) {
  const acao = acaoPrincipal(linha);

  return (
    <article className={`atende${destaque ? ' atende--agora' : ''}`}>
      <p className="atende__hora tabular">{linha.start}</p>
      <h3 className="atende__nome">{linha.customerName ?? 'Sem cadastro'}</h3>
      <p className="atende__servico">{linha.services.join(' + ') || 'Sem serviço'}</p>

      {RÓTULO[linha.status] ? (
        <p className="atende__estado">{RÓTULO[linha.status]}</p>
      ) : null}

      <div className="atende__acoes">
        {acao ? <Botao acao={acao} linha={linha} /> : null}
        {linha.customerId ? (
          <a className="ui-button ui-button--secondary ui-button--block"
             href={`/admin/cliente/${linha.customerId}?de=meu-dia`}>
            Ver a ficha
          </a>
        ) : null}
      </div>
    </article>
  );
}

export default async function MeuDiaPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;
  const erro = first(query['erro']);

  const painel = await painelDoDia(token);

  const topo = (
    <header className="painel__topo">
      <span className="painel__marca">{estado.businessName}</span>
      <form action={acaoSair}>
        <button className="ui-button ui-button--ghost painel__sair" type="submit">
          Sair
        </button>
      </form>
    </header>
  );

  if (!painel.ok) {
    return (
      <main className="ui-container painel__conteudo">
        {topo}
        <h1 className="painel__titulo">Meu dia</h1>
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[painel.code] ?? FALHA['request_failed']}
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/meu-dia">
            Tentar de novo
          </a>
        </div>
      </main>
    );
  }

  /**
   * O recorte vem do domínio, não daqui.
   *
   * A resposta já chega filtrada pela cadeira de quem pediu — quem não tem
   * `appointments.view_all_professionals` só enxerga a própria agenda, e isso é
   * decidido no servidor a partir da sessão. A tela nunca filtra por
   * profissional: filtro de tela é aparência de recorte, não recorte.
   */
  const dia = recortarMeuDia(painel.dados.entries, new Date());

  return (
    <main className="ui-container meu-dia">
      {topo}

      <h1 className="painel__titulo">Meu dia</h1>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      <p className="meu-dia__intervalo">{fraseDoIntervalo(dia.minutosAteProximo)}</p>

      {dia.agora ? (
        <section className="meu-dia__bloco">
          <h2 className="meu-dia__rotulo">Na cadeira</h2>
          <Cartao destaque linha={dia.agora} />
        </section>
      ) : null}

      {dia.proximo ? (
        <section className="meu-dia__bloco">
          <h2 className="meu-dia__rotulo">Próximo</h2>
          <Cartao destaque={!dia.agora} linha={dia.proximo} />
        </section>
      ) : null}

      {!dia.agora && !dia.proximo ? (
        <div className="vazio">
          <p className="vazio__titulo">
            {dia.concluidos > 0 ? 'Acabou por hoje' : 'Nada marcado para você hoje'}
          </p>
          <p className="vazio__saida">
            {dia.concluidos > 0
              ? `${dia.concluidos} ${dia.concluidos === 1 ? 'atendimento' : 'atendimentos'} hoje. Bom descanso.`
              : 'Quando alguém marcar com você, aparece aqui. A recepção também pode encaixar quem chegar.'}
          </p>
        </div>
      ) : null}

      {dia.depois.length > 0 ? (
        <section className="meu-dia__bloco">
          <h2 className="meu-dia__rotulo">Depois</h2>
          <ul className="depois">
            {dia.depois.map((linha) => (
              <li className="depois__item" key={linha.id}>
                <span className="depois__hora tabular">{linha.start}</span>
                <span className="depois__nome">{linha.customerName ?? 'Sem cadastro'}</span>
                <span className="depois__servico">{linha.services.join(' + ')}</span>
                {linha.customerId ? (
                  <a className="depois__ficha" href={`/admin/cliente/${linha.customerId}?de=meu-dia`}>
                    Ficha
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <dl className="meu-dia__resumo">
        <div>
          <dt>Restam</dt>
          <dd className="tabular">{dia.restam}</dd>
        </div>
        <div>
          <dt>Feitos</dt>
          <dd className="tabular">{dia.concluidos}</dd>
        </div>
        <div>
          <dt>Faltaram</dt>
          <dd className="tabular">{dia.faltaram}</dd>
        </div>
      </dl>
    </main>
  );
}
