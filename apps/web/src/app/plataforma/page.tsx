import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  listarBarbearias,
  listarPlanos,
  recursosDaBarbearia,
  suportesAbertos,
  type BarbeariaNaPlataforma,
  type Plano,
  type RecursoDaBarbearia,
} from '@/lib/plataforma-api';
import { lerSessaoDaPlataforma } from '@/lib/sessao-plataforma';
import { reais } from '@/lib/dinheiro';
import {
  acaoBloquear,
  acaoDefinirRecurso,
  acaoDesbloquear,
  acaoEncerrarSuporte,
  acaoEntrarNaConta,
  acaoTrocarPlano,
} from './acoes';

/**
 * As barbearias da plataforma.
 *
 * Uma linha por barbearia, com plano e estado, e as duas ações que este bloco
 * entrega: trocar o plano e bloquear a conta.
 *
 * O bloqueio abre um `<details>` com o campo de motivo em vez de um botão
 * direto. Não é enfeite: bloquear tira do ar a página pública e derruba quem
 * estiver logado, e um clique sem confirmação numa lista de linhas parecidas é
 * como se bloqueia a barbearia de baixo. O motivo digitado **é** a confirmação
 * — e é o mesmo texto que o dono lê quando tenta entrar.
 */

export const metadata: Metadata = {
  title: 'Barbearias',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const FALHA: Record<string, string> = {
  reason_required: 'Escreva o motivo do bloqueio.',
  not_blockable: 'Esta barbearia não existe mais ou já estava bloqueada.',
  not_blocked: 'Esta barbearia já estava ativa.',
  unknown_plan: 'Este plano não existe.',
  unknown_tenant: 'Esta barbearia não existe mais.',
  inactive_plan: 'Este plano não é mais oferecido.',
  unauthorized: 'A sessão venceu. Entre de novo.',
  mfa_required: 'Confirme o segundo fator antes de entrar numa conta.',
  mfa_setup_required: 'Ative o segundo fator antes de entrar numa conta.',
  no_owner: 'Esta barbearia não tem dono ativo para o suporte usar.',
  no_support: 'Não há suporte aberto nesta conta.',
  tenant_blocked: 'Reative a conta antes de entrar nela.',
  request_failed: 'Não deu para concluir. Tente de novo.',
  /**
   * O `viewer` — que é como toda conta de plataforma nasce.
   *
   * A guarda responde 403 de propósito, com o argumento escrito: quem está do
   * outro lado está autenticado e a rota existe. O painel, porém, não traduzia
   * o código, e a pessoa lia "não deu para concluir, tente de novo" e tentava
   * de novo — que é exatamente o que a escolha do 403 existia para evitar.
   */
  forbidden: 'Sua conta só consulta a plataforma. Peça a quem opera para fazer isto.',
};

const FEITO: Record<string, string> = {
  plano: 'Plano alterado.',
  recurso: 'Recurso atualizado.',
  suporte_encerrado: 'Suporte encerrado. As sessões abertas naquela conta caíram.',
  bloqueio: 'Conta bloqueada. A página pública saiu do ar.',
  desbloqueio: 'Conta reativada.',
};


const dia = (iso: string): string =>
  new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

function Linha({
  barbearia,
  planos,
  recursos,
  comSuporte,
  opera,
}: {
  readonly barbearia: BarbeariaNaPlataforma;
  readonly planos: readonly Plano[];
  readonly recursos: readonly RecursoDaBarbearia[];
  readonly comSuporte: boolean;
  /**
   * `operator` age; `viewer` só lê — e é como **toda conta nasce**.
   *
   * Sem isto o painel desenhava Bloquear, Reativar, Salvar plano, ligar recurso
   * e Entrar na conta para quem a guarda recusa. A pessoa clicava, levava 403 e
   * lia "não deu para concluir, tente de novo" — abrindo chamado achando que o
   * painel quebrou, que é literalmente o que a guarda escolheu 403 em vez de
   * 404 para evitar. A recusa de verdade continua na API; isto é a tela parando
   * de prometer.
   */
  readonly opera: boolean;
}) {
  const oferecidos = planos.filter((p) => p.active || p.code === barbearia.plano?.code);

  return (
    <li className={`conta ${barbearia.bloqueada ? 'conta--bloqueada' : ''}`}>
      <div className="conta__quem">
        <h2 className="conta__nome">
          {barbearia.nome}
          {barbearia.bloqueada ? <span className="conta__selo">bloqueada</span> : null}
        </h2>
        <p className="conta__meta">
          {barbearia.slug ? (
            <span className="conta__slug">/{barbearia.slug}</span>
          ) : (
            <span className="conta__slug conta__slug--vazio">sem endereço publicado</span>
          )}
          <span>desde {dia(barbearia.criadaEm)}</span>
        </p>
        {barbearia.bloqueada && barbearia.motivoDoBloqueio ? (
          <p className="conta__motivo">
            {barbearia.motivoDoBloqueio}
            {barbearia.bloqueadaEm ? <> · desde {dia(barbearia.bloqueadaEm)}</> : null}
          </p>
        ) : null}
      </div>

      {!opera ? (
        // O plano continua visível — é o que a conta de consulta existe para
        // consultar. O que sai é o formulário que a guarda recusaria.
        <div className="conta__plano">
          <p className="ui-field__label">Plano</p>
          <p className="conta__plano-atual">{barbearia.plano?.name ?? 'sem plano'}</p>
        </div>
      ) : (
      <form action={acaoTrocarPlano} className="conta__plano">
        <input name="tenantId" type="hidden" value={barbearia.tenantId} />
        <label className="ui-field__label" htmlFor={`plano-${barbearia.tenantId}`}>
          Plano
        </label>
        <div className="conta__plano-linha">
          <select
            className="ui-field__input"
            defaultValue={barbearia.plano?.code ?? ''}
            id={`plano-${barbearia.tenantId}`}
            name="planoCode"
          >
            <option disabled value="">
              sem plano
            </option>
            {oferecidos.map((plano) => (
              <option key={plano.code} value={plano.code}>
                {/* O teto de cadeiras entra só quando existe. "Cadeiras
                    ilimitadas" é a informação mais longa da lista e a que menos
                    muda uma decisão — era ela que estourava o campo. */}
                {plano.name} · {reais(plano.priceCents)}
                {plano.maxChairs === null ? '' : ` · ${plano.maxChairs} cadeiras`}
              </option>
            ))}
          </select>
          <button className="ui-button ui-button--secondary" type="submit">
            Salvar
          </button>
        </div>
      </form>
      )}

      <div className="conta__recursos">
        <p className="ui-field__label">Recursos</p>
        <ul className="recursos">
          {recursos.map((recurso) => (
            <li className="recursos__item" key={recurso.code}>
              {/*
                Para quem consulta, o recurso é **estado**, não interruptor: o
                botão levaria 403 e a tela diria "tente de novo".
              */}
              {!opera ? (
                <span
                  className={`recursos__botao ${recurso.ligado ? 'recursos__botao--ligado' : ''}`}
                  title={recurso.descricao}
                >
                  {recurso.nome}
                  <span className="recursos__estado">
                    {recurso.ligado ? 'ligado' : 'desligado'}
                  </span>
                </span>
              ) : (
              <form action={acaoDefinirRecurso} className="recursos__forma">
                <input name="tenantId" type="hidden" value={barbearia.tenantId} />
                <input name="code" type="hidden" value={recurso.code} />
                <input name="ligado" type="hidden" value={recurso.ligado ? '0' : '1'} />
                <button
                  aria-pressed={recurso.ligado}
                  className={`recursos__botao ${recurso.ligado ? 'recursos__botao--ligado' : ''}`}
                  title={recurso.descricao}
                  type="submit"
                >
                  {recurso.nome}
                  <span className="recursos__estado">{recurso.ligado ? 'ligado' : 'desligado'}</span>
                </button>
              </form>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/*
        Tudo aqui dentro é ação, e ação é de quem opera.

        A primeira versão deste bloco escondia só Bloquear e Reativar — "Entrar
        na conta" e "Encerrar suporte" continuavam desenhados, e os dois levam
        403 pela mesma guarda. O print da conta de consulta foi quem mostrou: a
        tela ficava com a frase "sua conta consulta" logo acima de três botões
        de operação.
      */}
      {!opera ? null : (
      <div className="conta__acao">
        {barbearia.bloqueada ? (
          <form action={acaoDesbloquear}>
            <input name="tenantId" type="hidden" value={barbearia.tenantId} />
            <button className="ui-button ui-button--primary" type="submit">
              Reativar
            </button>
          </form>
        ) : (
          <details className="conta__bloquear">
            <summary className="ui-button ui-button--secondary conta__bloquear-abrir">
              Bloquear
            </summary>
            <form action={acaoBloquear} className="conta__bloquear-form">
              <input name="tenantId" type="hidden" value={barbearia.tenantId} />
              <label className="ui-field__label" htmlFor={`motivo-${barbearia.tenantId}`}>
                Motivo
              </label>
              <input
                className="ui-field__input"
                id={`motivo-${barbearia.tenantId}`}
                maxLength={500}
                minLength={3}
                name="motivo"
                placeholder="inadimplente há 60 dias"
                required
                type="text"
              />
              <p className="conta__aviso">
                A página pública sai do ar e quem estiver no painel é desconectado. O dono lê este
                motivo ao tentar entrar.
              </p>
              <button className="ui-button ui-button--danger" type="submit">
                Bloquear {barbearia.nome}
              </button>
            </form>
          </details>
        )}

        {comSuporte ? (
          <form action={acaoEncerrarSuporte}>
            <input name="tenantId" type="hidden" value={barbearia.tenantId} />
            <button className="ui-button ui-button--danger" type="submit">
              Encerrar suporte
            </button>
          </form>
        ) : null}

        {barbearia.bloqueada ? null : (
          <details className="conta__bloquear">
            <summary className="ui-button ui-button--secondary conta__bloquear-abrir">
              Entrar na conta
            </summary>
            <form action={acaoEntrarNaConta} className="conta__bloquear-form">
              <input name="tenantId" type="hidden" value={barbearia.tenantId} />
              <label className="ui-field__label" htmlFor={`suporte-${barbearia.tenantId}`}>
                Motivo
              </label>
              <input
                className="ui-field__input"
                id={`suporte-${barbearia.tenantId}`}
                maxLength={500}
                minLength={3}
                name="motivo"
                placeholder="chamado 4471: horário sumindo da grade"
                required
                type="text"
              />
              <p className="conta__aviso">
                Sessão de trinta minutos, somente leitura, e o dono vê na trilha dele quem entrou e
                o que foi acessado. Exige o segundo fator confirmado.
              </p>
              <button className="ui-button ui-button--secondary" type="submit">
                Entrar como suporte
              </button>
            </form>
          </details>
        )}
      </div>
      )}
    </li>
  );
}

export default async function BarbeariasPage({ searchParams }: Props) {
  const token = await lerSessaoDaPlataforma();
  if (!token) redirect('/plataforma/entrar');

  const query = await searchParams;
  const erro = typeof query['erro'] === 'string' ? query['erro'] : undefined;
  const feito = typeof query['feito'] === 'string' ? query['feito'] : undefined;

  const [lista, catalogo, suportes] = await Promise.all([
    listarBarbearias(token),
    listarPlanos(token),
    suportesAbertos(token),
  ]);

  if (!lista.ok) {
    if (lista.code === 'unauthorized') redirect('/plataforma/entrar');
    return (
      <main className="ui-container painel__conteudo plataforma__trabalho">
        <h1 className="painel__titulo">Barbearias</h1>
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar a lista. Recarregue a página.
        </div>
      </main>
    );
  }

  const barbearias = lista.dados.barbearias;
  const opera = lista.dados.papel === 'operator';
  const planos = catalogo.ok ? catalogo.dados.planos : [];
  const bloqueadas = barbearias.filter((b) => b.bloqueada).length;

  // Uma chamada por barbearia, **em paralelo**. A alternativa seria a API
  // devolver os recursos junto da lista, e ela vai devolver no dia em que a
  // base crescer o bastante para isto aparecer numa medição — hoje são três
  // linhas por barbearia numa tela que a plataforma abre algumas vezes por dia.
  const porBarbearia = await Promise.all(
    barbearias.map(async (b) => {
      const r = await recursosDaBarbearia(token, b.tenantId);
      return [b.tenantId, r.ok ? r.dados.recursos : []] as const;
    }),
  );
  const recursos = new Map(porBarbearia);
  const comSuporte = new Set(
    (suportes.ok ? suportes.dados.suportes : []).map((s) => s.tenantId),
  );

  return (
    <main className="ui-container painel__conteudo plataforma__trabalho">
      <h1 className="painel__titulo">Barbearias</h1>
      <p className="painel__sub">
        {barbearias.length} {barbearias.length === 1 ? 'conta' : 'contas'}
        {bloqueadas > 0 ? ` · ${bloqueadas} bloqueada${bloqueadas === 1 ? '' : 's'}` : null}
      </p>

      {/*
        O que **esta** conta pode fazer, dito antes de qualquer botão.

        Sem a frase, o `viewer` — que é como toda conta de plataforma nasce —
        percorre a tela sem entender por que nada acontece. Com ela, a ausência
        dos botões passa a ter explicação em vez de parecer defeito.
      */}
      {!opera ? (
        <p className="ui-alert ui-alert--warning painel__aviso" role="status">
          Sua conta <strong>consulta</strong> a plataforma. Bloquear, trocar plano, ligar recurso e
          entrar numa conta são de quem opera — peça a quem tem esse acesso.
        </p>
      ) : null}

      {feito ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          {FEITO[feito] ?? 'Pronto.'}
        </div>
      ) : null}
      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? 'Não deu para concluir. Tente de novo.'}
        </div>
      ) : null}

      {barbearias.length === 0 ? (
        <div className="vazio">
          <p className="vazio__titulo">Nenhuma barbearia ainda</p>
          <p className="vazio__saida">
            A primeira aparece aqui assim que alguém criar a conta pelo cadastro.
          </p>
        </div>
      ) : (
        <ul className="contas">
          {barbearias.map((barbearia) => (
            <Linha
              barbearia={barbearia}
              key={barbearia.tenantId}
              planos={planos}
              comSuporte={comSuporte.has(barbearia.tenantId)}
              opera={opera}
              recursos={recursos.get(barbearia.tenantId) ?? []}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
