import { redirect } from 'next/navigation';
import {
  ACAO_PRINCIPAL,
  ROTULO_DO_ESTADO,
  TOM_SEMANTICO_DO_ESTADO,
  VERBO_CURTO,
  type AttendanceAction as AcaoAtendimento,
} from '@barbearia/core';
import type { Metadata } from 'next';
import { recortarMeuDia, fraseDoIntervalo } from '@barbearia/core';
import { painelDoDia, type LinhaDoDia } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoSair } from '../acoes';
import { ProNav } from '../pro-nav';
import { secao } from '../secoes';
import { QuemQueriaAVaga } from '../quem-queria-a-vaga';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';
import { marcaDaRecusa } from '../falha-da-leitura';

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

/**
 * O mesmo vocabulário do balcão, vindo de `packages/core`.
 *
 * Esta tela dizia **Começar** e **Terminei** para o que o balcão chamava de
 * **Iniciar** e **Concluir** — e as duas pessoas trabalham no mesmo salão,
 * falando uma com a outra em voz alta. O verbo curto é o que cabe no cartão de
 * 360px; o nome é o mesmo dos dois lados.
 */
const RÓTULO = ROTULO_DO_ESTADO;
const VERBO = VERBO_CURTO;

/**
 * A ação que o barbeiro faz nesta linha — uma só, a próxima.
 *
 * `ACAO_PRINCIPAL` é a mesma tabela que o balcão usa: o que muda entre as duas
 * telas é quantas ações aparecem, não qual é a próxima.
 */
function acaoPrincipal(linha: LinhaDoDia): AcaoAtendimento | null {
  const candidata = ACAO_PRINCIPAL[linha.status];
  return candidata && linha.actions.includes(candidata) ? candidata : null;
}

function Botao({
  linha,
  acao,
}: {
  readonly linha: LinhaDoDia;
  readonly acao: AcaoAtendimento;
}) {
  return (
    <form action="/admin/dia/atender" method="post">
      <input name="id" type="hidden" value={linha.id} />
      <input name="action" type="hidden" value={acao} />
      <input name="voltar" type="hidden" value="/admin/meu-dia" />
      <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
        {VERBO[acao]}
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
        <p className={`atende__estado selo selo--${TOM_SEMANTICO_DO_ESTADO[linha.status]}`}>{RÓTULO[linha.status]}</p>
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
      <main className="ui-container painel__conteudo" {...secao('meu-dia')}>
        {topo}
        <ProNav atual="/admin/meu-dia" />
        <h1 className="painel__titulo">Meu dia</h1>
        <div className="ui-alert ui-alert--warning" role="alert" {...marcaDaRecusa(painel.code)}>
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
    <main className="ui-container meu-dia" {...secao('meu-dia')}>
      {topo}
      <ProNav atual="/admin/meu-dia" />

      <h1 className="painel__titulo">Meu dia</h1>

      {erro ? (
        <AvisoDeRecusa erro={erro} mapa={FALHA} className="painel__aviso" />
      ) : null}

      <QuemQueriaAVaga />

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
