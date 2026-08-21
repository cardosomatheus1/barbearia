import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  assinaturasNaApi,
  cobrancaNaApi,
  listarBarbearias,
  type AssinaturaNaPlataforma,
  type MeioDeCobrancaNaTela,
} from '@/lib/plataforma-api';
import { lerSessaoDaPlataforma } from '@/lib/sessao-plataforma';
import {
  acaoCancelarAssinatura,
  acaoReativarAssinatura,
  acaoSalvarCobranca,
} from '../acoes';
import { AvisoDeRecusa } from '../aviso-de-recusa';
import { reais } from '@/lib/dinheiro';
import {
  assinaturaDaPlataformaEmDia,
  ROTULO_DO_ESTADO_DA_ASSINATURA_DA_PLATAFORMA,
  type EstadoDaAssinaturaDaPlataforma,
} from '@barbearia/core';

/**
 * O contrato com cada barbearia, e o que dá para fazer com ele (bloco 128).
 *
 * ## A ausência que esta tela fecha
 *
 * As rotas existiam **inteiras** desde o bloco 27 — cancelar, reativar, trocar o
 * cartão, estornar crédito —, com guarda, `@AgeNaConta` e trilha. Nenhuma tinha
 * cliente em `plataforma-api.ts`, e `subscriptions.status` não aparecia em lugar
 * nenhum do painel. Rota inteira sem cliente na tela é a mesma coisa que a rota
 * não existir, e pior: tudo parece pronto.
 *
 * O custo era do outro lado. `/admin/plano` diz ao dono, em letras, *"para
 * trocar o cartão, fale com o suporte"* — e o suporte não tinha essa tela: era
 * `curl` ou `UPDATE` à mão num banco de produção. A metade irmã funciona (a
 * fatura tem "Registrar pagamento" e "Anular"), o que tornava a falta fácil de
 * não notar.
 *
 * ## Por que tela própria, e não dentro do cartão da barbearia
 *
 * `/plataforma` já carrega bloqueio, plano, suporte e recursos por barbearia, e
 * o cartão passou a ter dois campos `motivo` dentro de dois `details` iguais —
 * o defeito que a convenção de "dois campos com o mesmo `name` na mesma tela"
 * descreve. Cancelamento e cartão trazem um terceiro e um quarto. A pergunta
 * aqui também é outra: no cartão é *"esta conta pode operar?"*, aqui é *"o que
 * ela contratou, e está pagando?"*.
 */

export const metadata: Metadata = {
  title: 'Assinaturas',
  robots: { index: false, follow: false },
};



/**
 * O tom do selo sai do **estado**, e o mapa é total sobre a união.
 *
 * `Record<string, string>` deixaria o estado novo chegar sem classe — e o
 * sintoma seria um selo sem cor ao lado de um estado que ninguém sabe ler.
 *
 * As quatro variantes são as que o design system já tem (`feito`, `agora`,
 * `espera`, `fora`): nome de classe novo para o mesmo desenho é a briga de
 * regras que `.escolha` já custou uma vez.
 */
const TOM_DO_ESTADO: Readonly<Record<EstadoDaAssinaturaDaPlataforma, string>> = {
  active: 'selo--feito',
  trialing: 'selo--agora',
  past_due: 'selo--espera',
  canceled: 'selo--fora',
};

const dia = (iso: string): string =>
  new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

const RECUSA: Readonly<Record<string, string>> = {
  reason_required: 'Escreva o motivo: ele fica na trilha e é o que explica a decisão depois.',
  invalid_request: 'Confira os campos do cartão — o final são exatamente quatro dígitos.',
  unknown_tenant: 'Esta barbearia não existe mais.',
  forbidden: 'Sua conta lê a plataforma, mas não age sobre a conta de uma barbearia.',
  request_failed: 'Não deu para concluir. Tente de novo.',
};

function Cartao({
  assinatura,
  cobranca,
  nome,
}: {
  readonly assinatura: AssinaturaNaPlataforma;
  readonly cobranca: MeioDeCobrancaNaTela | null;
  /**
   * O nome da barbearia, resolvido da lista — como na trilha e na cobrança.
   *
   * A primeira versão mostrava `assinatura.publico`, que é `plans.audience`: o
   * **público-alvo do plano**. Os quatro cartões saíam com o mesmo título,
   * "Barbearias", e nenhum dizia de quem era a assinatura. O print pegou; nada
   * no portão pegaria, porque o campo existe e tem valor.
   */
  readonly nome: string;
}) {
  const cancelada = assinatura.estado === 'canceled';
  const meio = cobranca?.meio ?? null;

  return (
    <li className="cobranca__item">
      <div className="cobranca__cabeca">
        <p className="cobranca__barbearia">{nome}</p>
        <p className="cobranca__valor">{reais(assinatura.precoCents)}/mês</p>
      </div>

      <p className="cobranca__prazo">
        <span className={`selo ${TOM_DO_ESTADO[assinatura.estado]}`}>
          {ROTULO_DO_ESTADO_DA_ASSINATURA_DA_PLATAFORMA[assinatura.estado]}
        </span>{' '}
        {assinatura.planoNome} · {assinatura.cadeirasEmUso}
        {assinatura.tetoDeCadeiras === null ? '' : ` de ${assinatura.tetoDeCadeiras}`} cadeiras ·{' '}
        {cancelada && assinatura.canceladaEm
          ? `cancelada em ${dia(assinatura.canceladaEm)}, vale até ${dia(assinatura.periodoAte)}`
          : `período até ${dia(assinatura.periodoAte)}`}
        {assinatura.testeAte ? ` · teste até ${dia(assinatura.testeAte)}` : ''}
      </p>

      {/*
        O cartão em letras, e nunca o número.

        O que este schema guarda é o token do adquirente, a bandeira e os quatro
        últimos — não existe coluna para PAN nem para CVV, e há invariante que
        reprova quem criar uma. O que a tela mostra é o que o suporte lê em voz
        alta para o dono conferir ao telefone.
      */}
      <p className="cobranca__prazo">
        {meio && meio.cadastrado
          ? `Cartão ${meio.bandeira ?? '—'} •••• ${meio.final ?? '••••'}${
              meio.validadeMes && meio.validadeAno
                ? ` · vence ${String(meio.validadeMes).padStart(2, '0')}/${meio.validadeAno}`
                : ''
            }`
          : 'Sem cartão cadastrado — a régua não tem como cobrar.'}
      </p>

      <div className="cobranca__acoes">
        {cancelada ? (
          /*
            A saída, que é o que faltava.

            Cancelar por engano deixava a barbearia sem plano para sempre: o
            mecanismo existe desde o bloco 27 e nenhuma tela o alcançava. É o
            estado sem saída da §6, pergunta 3.
          */
          <form action={acaoReativarAssinatura}>
            <input name="tenantId" type="hidden" value={assinatura.tenantId} />
            <button className="ui-button ui-button--primary" type="submit">
              Reativar assinatura
            </button>
          </form>
        ) : (
          <details className="dobra">
            <summary className="dobra__titulo">Cancelar assinatura</summary>
            <form action={acaoCancelarAssinatura} className="formulario">
              <input name="tenantId" type="hidden" value={assinatura.tenantId} />
              <div className="ui-field">
                <label
                  className="ui-field__label"
                  htmlFor={`motivoDoCancelamento-${assinatura.tenantId}`}
                >
                  Por que está cancelando
                </label>
                {/*
                  `motivoDoCancelamento` e não `motivo`: esta tela tem um campo de
                  motivo por gesto, e dois campos com o mesmo `name` na mesma
                  tela são dois destinos para o mesmo preenchimento — quem opera
                  com pressa erra por isso, e quem escreve o percurso também.
                */}
                <input
                  className="ui-field__input"
                  id={`motivoDoCancelamento-${assinatura.tenantId}`}
                  maxLength={500}
                  minLength={3}
                  name="motivoDoCancelamento"
                  required
                  type="text"
                />
                <p className="ui-field__hint">
                  Vale até {dia(assinatura.periodoAte)} — o que já foi pago continua entregue.
                </p>
              </div>
              <button className="ui-button ui-button--secondary" type="submit">
                Cancelar assinatura
              </button>
            </form>
          </details>
        )}

        <details className="dobra">
          <summary className="dobra__titulo">
            {meio && meio.cadastrado ? 'Trocar o cartão' : 'Cadastrar cartão'}
          </summary>
          <form action={acaoSalvarCobranca} className="formulario">
            <input name="tenantId" type="hidden" value={assinatura.tenantId} />
            <p className="ui-field__hint">
              Os dados vêm do adquirente, nunca do cartão na mão do cliente: aqui entram o
              identificador da conta, o token do meio e os quatro últimos dígitos. O número do
              cartão não tem onde ser guardado neste sistema.
            </p>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor={`pspCustomerId-${assinatura.tenantId}`}>
                Identificador da conta no adquirente
              </label>
              <input
                className="ui-field__input"
                id={`pspCustomerId-${assinatura.tenantId}`}
                name="pspCustomerId"
                required
                type="text"
              />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor={`pspMethodId-${assinatura.tenantId}`}>
                Token do cartão
              </label>
              <input
                className="ui-field__input"
                id={`pspMethodId-${assinatura.tenantId}`}
                name="pspMethodId"
                required
                type="text"
              />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor={`bandeira-${assinatura.tenantId}`}>
                Bandeira
              </label>
              <input
                className="ui-field__input"
                id={`bandeira-${assinatura.tenantId}`}
                name="bandeira"
                required
                type="text"
              />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor={`final-${assinatura.tenantId}`}>
                Quatro últimos dígitos
              </label>
              <input
                className="ui-field__input tabular"
                id={`final-${assinatura.tenantId}`}
                inputMode="numeric"
                maxLength={4}
                name="final"
                pattern="[0-9]{4}"
                required
                type="text"
              />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor={`validadeMes-${assinatura.tenantId}`}>
                Validade
              </label>
              <div className="cobranca__validade">
                <input
                  aria-label="Mês de validade"
                  className="ui-field__input tabular"
                  id={`validadeMes-${assinatura.tenantId}`}
                  inputMode="numeric"
                  max={12}
                  min={1}
                  name="validadeMes"
                  placeholder="MM"
                  required
                  type="number"
                />
                <input
                  aria-label="Ano de validade"
                  className="ui-field__input tabular"
                  inputMode="numeric"
                  max={2100}
                  min={2024}
                  name="validadeAno"
                  placeholder="AAAA"
                  required
                  type="number"
                />
              </div>
            </div>
            <button className="ui-button ui-button--primary" type="submit">
              Salvar cartão
            </button>
          </form>
        </details>
      </div>

      {cobranca && cobranca.estornos.length > 0 ? (
        <p className="cobranca__prazo">
          {cobranca.estornos.length}{' '}
          {cobranca.estornos.length === 1 ? 'estorno' : 'estornos'} ·{' '}
          {reais(cobranca.estornos.reduce((s, e) => s + e.valorCents, 0))} devolvidos
        </p>
      ) : null}
    </li>
  );
}

export default async function AssinaturasDaPlataformaPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ feito?: string; erro?: string }>;
}) {
  const parametros = await searchParams;
  const token = await lerSessaoDaPlataforma();
  if (!token) redirect('/plataforma/entrar');

  const [lista, barbearias] = await Promise.all([
    assinaturasNaApi(token),
    listarBarbearias(token),
  ]);
  if (!lista.ok) {
    if (lista.code === 'unauthorized') redirect('/plataforma/entrar');
    return (
      <main className="ui-container painel__conteudo plataforma__trabalho">
        <h1 className="painel__titulo">Assinaturas</h1>
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar as assinaturas. Recarregue a página.
        </div>
      </main>
    );
  }

  const assinaturas = lista.dados.assinaturas;
  // O nome muda, o `tenant_id` não — é a razão de a trilha e a cobrança
  // resolverem daqui também, e não de guardarem o nome junto do fato.
  const nomes = new Map(
    (barbearias.ok ? barbearias.dados.barbearias : []).map((b) => [b.tenantId, b.nome] as const),
  );

  /**
   * O meio de cobrança de cada uma, em paralelo.
   *
   * Uma ida por barbearia é o que a rota oferece, e o produto tem uma dezena
   * delas: `Promise.all` resolve em uma volta de rede. Se a base crescer, a
   * resposta é uma rota que devolva o conjunto — nunca um laço sequencial aqui.
   */
  const cobrancas = await Promise.all(
    assinaturas.map((a) =>
      cobrancaNaApi(token, a.tenantId).then((r) => (r.ok ? r.dados : null)),
    ),
  );

  const emDia = assinaturas.filter((a) => assinaturaDaPlataformaEmDia(a.estado)).length;

  return (
    <main className="ui-container painel__conteudo plataforma__trabalho">
      <h1 className="painel__titulo">Assinaturas</h1>
      <p className="painel__sub">
        O que cada barbearia contratou, e o que dá para fazer com o contrato dela: cancelar com
        motivo, reativar e trocar o cartão que a régua cobra.
      </p>

      {parametros.feito ? (
        <div className="ui-alert ui-alert--success" role="status">
          {parametros.feito === 'cancelamento'
            ? 'Assinatura cancelada. O período pago continua entregue, e ela pode ser reativada aqui.'
            : parametros.feito === 'reativacao'
              ? 'Assinatura reativada.'
              : 'Cartão salvo. A próxima cobrança usa ele.'}
        </div>
      ) : null}

      <AvisoDeRecusa erro={parametros.erro} mapa={RECUSA} />

      {assinaturas.length === 0 ? (
        <div className="vazio">
          <p className="vazio__titulo">Nenhuma assinatura ainda</p>
          <p className="vazio__saida">
            Toda barbearia que conclui o cadastro nasce com um plano. A primeira aparece aqui.
          </p>
        </div>
      ) : (
        <>
          <p className="cobranca__total">
            {assinaturas.length} {assinaturas.length === 1 ? 'assinatura' : 'assinaturas'} ·{' '}
            {emDia} em dia
          </p>
          <ul className="cobranca__lista">
            {assinaturas.map((a, i) => (
              <Cartao
                assinatura={a}
                cobranca={cobrancas[i] ?? null}
                key={a.tenantId}
                nome={nomes.get(a.tenantId) ?? a.tenantId}
              />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
