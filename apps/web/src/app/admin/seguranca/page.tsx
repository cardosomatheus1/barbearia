import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  preferenciasDeAlerta,
  segundoFator,
  sessoesDaConta,
  type PreferenciasDeAlerta,
  type SessaoNaTela,
  type SuporteNaTela,
} from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import {
  lerCodigosDeRecuperacao,
  lerSegredoDoMfa,
  lerSessaoGestor,
} from '@/lib/sessao-gestor';
import {
  acaoComecarSegundoFator,
  acaoConfirmarSegundoFator,
  acaoEncerrarSessao,
  acaoExpulsarSuporte,
  acaoPoliticaDeSegundoFator,
  acaoPreferenciasDeAlerta,
  acaoSair,
  acaoVerificarSegundoFator,
} from '../acoes';
import { secao } from '../secoes';

/**
 * Segundo fator: a porta do dinheiro.
 *
 * A tela existe para três momentos diferentes, e a diferença entre eles é o
 * que decide o que aparece:
 *
 * 1. **Ainda não tem.** Mostra o cadastro — o segredo para digitar no
 *    autenticador e o campo do primeiro código.
 * 2. **Tem, mas não provou nesta sessão.** Mostra só o campo do código. É o
 *    caso que a recepção vive todo dia depois do almoço.
 * 3. **Provou.** Diz por quanto tempo vale e sai da frente.
 *
 * O segredo e os códigos de recuperação chegam por cookie de vida curta, nunca
 * pela URL: os dois são credencial ao portador e a URL fica no histórico da
 * máquina do balcão.
 *
 * **Não há QR Code desenhado aqui.** Gerar a imagem exigiria dependência nova
 * ou JavaScript no cliente, e este produto não tem componente de cliente em
 * lugar nenhum. O segredo em texto grande e espaçado é o que todo autenticador
 * aceita como entrada manual — e funciona em celular sem câmera boa, que é o
 * aparelho real de quem trabalha no balcão.
 */

export const metadata: Metadata = {
  title: 'Segurança',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  invalid_code: 'Código incorreto. Confira o aplicativo e tente de novo.',
  already_enabled: 'O segundo fator já está ativo nesta conta.',
  not_enabled: 'Comece o cadastro do segundo fator antes.',
  mfa_key_missing: 'Não foi possível concluir agora. Avise quem cuida do sistema.',
  invalid_request: 'Confira o código e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
  /*
    Os dois códigos que a política devolve quando ela está ligada.

    Sem eles a mensagem cairia no "não deu para salvar" genérico, que manda
    tentar de novo — e tentar de novo dá exatamente o mesmo erro, para sempre.
    O texto tem que dizer o passo que falta, porque ele está nesta mesma tela.
  */
  mfa_setup_required: 'Para desligar a exigência é preciso um autenticador cadastrado. Gere a chave aqui embaixo e volte.',
  mfa_required: 'Confirme o código do seu aplicativo aqui embaixo antes de mudar a exigência.',
};

/** Em grupos de quatro: ninguém digita trinta e dois caracteres seguidos sem errar. */
const emGrupos = (segredo: string): string =>
  (segredo.match(/.{1,4}/g) ?? [segredo]).join(' ');

const DESTINOS = [
  { chave: 'caixa', nome: 'Caixa' },
  { chave: 'fiado', nome: 'Fiado' },
  { chave: 'comanda', nome: 'Comanda' },
] as const;

export default async function SegurancaPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;
  const mfa = await segundoFator(token);

  const erro = first(query['erro']);
  const ativado = first(query['ativado']) === '1';
  const voltarPara = first(query['de']) ?? 'caixa';

  // Lidas junto com o resto: são rotas independentes, e em série o dono espera
  // as três somadas numa tela que ele abre com pressa.
  const [sessoes, preferencias] = await Promise.all([
    sessoesDaConta(token),
    preferenciasDeAlerta(token),
  ]);

  const segredo = await lerSegredoDoMfa();
  const codigos = await lerCodigosDeRecuperacao();

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

  if (!mfa.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('seguranca')}>
        {topo}
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[mfa.code] ?? FALHA['request_failed']} <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const {
    ativo,
    pendente,
    obrigatorio,
    obrigatorioNaBarbearia,
    podeMudarPolitica,
    verificadoNestaSessao,
  } = mfa.dados;
  const politica = first(query['politica']);

  return (
    <main className="ui-container painel__conteudo" {...secao('seguranca')}>
      {topo}

      <h1 className="painel__titulo">Segundo fator</h1>
      <p className="painel__sub">
        {obrigatorioNaBarbearia
          ? 'Um código de seis dígitos, do aplicativo do seu celular, para quem mexe em dinheiro. O balcão fica logado o dia inteiro — o código é o que separa a gaveta de quem passa por perto.'
          : 'Um código de seis dígitos, do aplicativo do seu celular. Esta barbearia não o exige hoje: quem tem acesso ao caixa entra sem ele.'}
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {ativado && codigos ? (
        <section className="cartao-seguranca cartao-seguranca--destaque">
          <h2 className="cartao-seguranca__titulo">Anote estes códigos agora</h2>
          <p className="cartao-seguranca__texto">
            São a sua saída se o celular sumir. Cada um serve uma vez, e{' '}
            <strong>esta é a única vez que eles aparecem</strong> — guardados de forma legível,
            deixariam de ser uma segunda chave e virariam uma cópia da primeira.
          </p>
          <ul className="codigos-recuperacao">
            {codigos.map((codigo) => (
              <li className="codigos-recuperacao__item" key={codigo}>
                {codigo}
              </li>
            ))}
          </ul>
          <a className="ui-button ui-button--primary ui-button--block" href="/admin/caixa">
            Anotei — ir para o caixa
          </a>
        </section>
      ) : null}

      {ativo ? (
        <section className="cartao-seguranca">
          <h2 className="cartao-seguranca__titulo">
            {verificadoNestaSessao ? 'Confirmado neste aparelho' : 'Confirme o código'}
          </h2>

          {verificadoNestaSessao ? (
            <>
              <p className="cartao-seguranca__texto">
                Este aparelho está liberado para o caixa por 30 minutos. Depois disso o código é
                pedido de novo, mesmo sem você sair.
              </p>
              <ul className="atalhos-dinheiro">
                {DESTINOS.map((destino) => (
                  <li key={destino.chave}>
                    <a className="ui-button ui-button--ghost" href={`/admin/${destino.chave}`}>
                      {destino.nome}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <form action={acaoVerificarSegundoFator} className="formulario">
              <input name="voltarPara" type="hidden" value={voltarPara} />
              <div className="ui-field">
                <label className="ui-field__label" htmlFor="codigo-verificar">
                  Código do aplicativo
                </label>
                <input
                  autoComplete="one-time-code"
                  className="ui-field__input campo-codigo"
                  id="codigo-verificar"
                  inputMode="numeric"
                  name="codigo"
                  placeholder="000000"
                  required
                />
                <p className="ui-field__hint">
                  Perdeu o celular? Digite um dos códigos de recuperação que você anotou.
                </p>
              </div>
              <button className="ui-button ui-button--primary ui-button--block" type="submit">
                Confirmar
              </button>
            </form>
          )}
        </section>
      ) : segredo || pendente ? (
        <section className="cartao-seguranca">
          <h2 className="cartao-seguranca__titulo">Passo 2: confirme o primeiro código</h2>

          {segredo ? (
            <>
              <p className="cartao-seguranca__texto">
                No aplicativo autenticador do celular (Google Authenticator, Authy, 1Password),
                escolha “adicionar chave manualmente” e digite:
              </p>
              <p className="segredo-mfa">{emGrupos(segredo.segredoBase32)}</p>
            </>
          ) : (
            <p className="cartao-seguranca__texto">
              O cadastro foi começado mas não confirmado. Se você não tem mais a chave à mão,
              comece de novo — a anterior deixa de valer.
            </p>
          )}

          <form action={acaoConfirmarSegundoFator} className="formulario">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="codigo-confirmar">
                Código que apareceu no aplicativo
              </label>
              <input
                autoComplete="one-time-code"
                className="ui-field__input campo-codigo"
                id="codigo-confirmar"
                inputMode="numeric"
                name="codigo"
                placeholder="000000"
                required
              />
            </div>
            <button className="ui-button ui-button--primary ui-button--block" type="submit">
              Ativar segundo fator
            </button>
          </form>

          <form action={acaoComecarSegundoFator}>
            <button className="ui-button ui-button--ghost ui-button--block" type="submit">
              Gerar outra chave
            </button>
          </form>
        </section>
      ) : (
        <section className="cartao-seguranca">
          <h2 className="cartao-seguranca__titulo">Passo 1: gerar a chave</h2>
          <p className="cartao-seguranca__texto">
            {obrigatorio
              ? 'Sua conta tem acesso ao financeiro, então o segundo fator é obrigatório: sem ele o caixa não abre.'
              : obrigatorioNaBarbearia
                ? 'Sua conta ainda não mexe em dinheiro, mas ligar o segundo fator protege o cadastro e a equipe.'
                : 'Esta barbearia não exige o código. Ligar mesmo assim protege a sua conta — e já deixa você pronto para o dia em que a exigência for ligada.'}
          </p>
          <form action={acaoComecarSegundoFator}>
            <button className="ui-button ui-button--primary ui-button--block" type="submit">
              Gerar chave
            </button>
          </form>
        </section>
      )}

      <PoliticaDaBarbearia
        ligada={obrigatorioNaBarbearia}
        podeMudar={podeMudarPolitica}
        acabouDeMudar={politica === 'ligada' ? true : politica === 'desligada' ? false : null}
      />

      {/*
        Quem está na minha conta, e o que me interrompe (bloco 33).

        Fica **nesta** tela e não numa nova porque é a mesma pergunta que o
        segundo fator responde do outro lado: quem consegue entrar aqui. Uma
        tela separada chamada "sessões" faria o dono ter que saber de antemão
        que segurança da conta mora em dois lugares.
      */}
      <QuemEstaNaConta
        encerrada={first(query['encerrada']) === '1'}
        expulso={first(query['suporte']) === 'fora'}
        salvo={first(query['salvo']) === '1'}
        sessoes={sessoes.ok ? sessoes.dados.sessoes : []}
        suporte={sessoes.ok ? sessoes.dados.suporte : []}
        preferencias={preferencias.ok ? preferencias.dados : null}
      />
    </main>
  );
}

/**
 * O interruptor da barbearia — a decisão que vale para todo mundo.
 *
 * Fica **abaixo** do cadastro do próprio aparelho de propósito. Quem abre esta
 * tela quase sempre veio digitar o código para destravar o caixa, trinta vezes
 * por mês; mudar a política da casa acontece uma vez na vida do negócio. Pôr a
 * decisão rara no topo empurraria a ação diária para baixo da dobra no celular.
 *
 * Quem não tem `security.mfa_policy` não vê o cartão. Mostrá-lo desabilitado
 * explicaria à recepção exatamente onde fica a trava que ela não pode mexer —
 * e ainda seria uma promessa que o servidor recusa.
 */
function PoliticaDaBarbearia({
  ligada,
  podeMudar,
  acabouDeMudar,
}: {
  readonly ligada: boolean;
  readonly podeMudar: boolean;
  readonly acabouDeMudar: boolean | null;
}) {
  if (!podeMudar) return null;

  return (
    <section className="cartao-seguranca">
      <h2 className="cartao-seguranca__titulo">O código é exigido nesta barbearia?</h2>

      {acabouDeMudar !== null ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          {acabouDeMudar
            ? 'Pronto. Quem mexe em dinheiro passa a precisar do código.'
            : 'Pronto. O caixa abre sem código até você ligar de novo.'}
        </div>
      ) : null}

      <p className={ligada ? 'estado estado--aberto' : 'estado'}>
        <span className="estado__ponto" />
        {ligada ? 'Exigido no caixa, na comanda e na comissão' : 'Não é exigido de ninguém'}
      </p>

      <p className="cartao-seguranca__texto">
        {ligada
          ? 'Quem tem acesso ao dinheiro digita o código uma vez a cada 30 minutos. Desligar significa que qualquer pessoa que sente no notebook aberto da recepção abre caixa, comanda, fiado e comissão — e esse notebook fica virado para o salão.'
          : 'Hoje a senha é a única porta do dinheiro. Ligar passa a pedir um código de seis dígitos de quem abre caixa, fecha comanda ou vê comissão — inclusive de você.'}
      </p>

      {ligada ? null : (
        /*
          O degrau, dito antes e não depois.

          Desligar a exigência é rota de dinheiro como qualquer outra — senão
          uma sessão esquecida no balcão a removeria num toque. Quem liga sem
          autenticador precisa cadastrar um para poder voltar atrás, e descobrir
          isso só na hora de voltar é o que transforma uma decisão em armadilha.
        */
        <p className="cartao-seguranca__texto">
          <strong>Para desligar depois</strong>, você vai precisar do código — é o que impede
          alguém de tirar a trava a partir de um computador aberto. Se ainda não tem autenticador,
          cadastre o seu aqui em cima antes de ligar.
        </p>
      )}

      <form action={acaoPoliticaDeSegundoFator}>
        {/*
          O estado desejado vai escrito no campo, e não uma caixa de marcar:
          caixa desmarcada não é enviada pelo navegador, e a ausência viraria
          "desligue a proteção" em qualquer envio que chegasse pela metade.
        */}
        <input name="obrigatorio" type="hidden" value={ligada ? 'nao' : 'sim'} />
        <button className="ui-button ui-button--secondary ui-button--block" type="submit">
          {ligada ? 'Deixar de exigir o código' : 'Passar a exigir o código'}
        </button>
      </form>

      <p className="ui-field__hint">
        Ligar e desligar ficam na trilha, com quem fez e quando.
      </p>
    </section>
  );
}

/**
 * As sessões abertas, o suporte na conta e o que interrompe o dono.
 *
 * Duas lacunas declaradas fechavam aqui — "encerrar sessão nos outros
 * aparelhos" (sem bloco desde o 5) e "o dono encerrar sozinho o suporte" (do
 * 26) — e elas eram a mesma tela: uma lista do que está aberto, com um botão ao
 * lado. Entregá-las separadas produziria duas telas que respondem à mesma
 * pergunta com metade da resposta.
 *
 * O suporte vem **primeiro** quando existe. A pergunta que o dono faz não é
 * "quantos aparelhos meus estão logados?", é "quem está na minha conta?" — e a
 * resposta que ele não espera é a que precisa estar no topo.
 */
function QuemEstaNaConta({
  sessoes,
  suporte,
  preferencias,
  encerrada,
  expulso,
  salvo,
}: {
  readonly sessoes: readonly SessaoNaTela[];
  readonly suporte: readonly SuporteNaTela[];
  readonly preferencias: PreferenciasDeAlerta | null;
  readonly encerrada: boolean;
  readonly expulso: boolean;
  readonly salvo: boolean;
}) {
  return (
    <>
      <h2 className="ficha__titulo">Quem está na sua conta</h2>

      {encerrada ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Aparelho desconectado.
        </div>
      ) : null}
      {expulso ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          O suporte saiu da sua conta.
        </div>
      ) : null}

      {suporte.length > 0 ? (
        <div className="ui-alert ui-alert--warning painel__aviso" role="alert">
          <p>
            <strong>{suporte[0]?.quem ?? 'Alguém do suporte'}</strong> está na sua conta agora —
            {' '}&ldquo;{suporte[0]?.motivo}&rdquo;. O acesso vence sozinho em até 30 minutos.
          </p>
          <form action={acaoExpulsarSuporte}>
            <button className="ui-button ui-button--secondary" type="submit">
              Tirar o suporte agora
            </button>
          </form>
        </div>
      ) : null}

      <ul className="sessoes">
        {sessoes.map((sessao) => (
          <li className="sessoes__item" key={sessao.id}>
            <div className="sessoes__texto">
              <span className="sessoes__aparelho">{sessao.aparelho}</span>
              <span className="sessoes__quando">
                Entrou em {dataCurta(sessao.criadaEm)}
                {sessao.atual ? ' · este aparelho' : ''}
              </span>
            </div>
            {sessao.atual ? null : (
              <form action={acaoEncerrarSessao}>
                <input name="id" type="hidden" value={sessao.id} />
                <button className="ui-button ui-button--ghost sessoes__botao" type="submit">
                  Desconectar
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>

      <h2 className="ficha__titulo">O que me avisar</h2>
      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Preferências salvas.
        </div>
      ) : null}

      <form action={acaoPreferenciasDeAlerta} className="formulario">
        <label className="marca" htmlFor="enviarCritico">
          <input defaultChecked={preferencias?.enviarCritico ?? true} id="enviarCritico"
                 name="enviarCritico" type="checkbox" />
          <span>Problemas que precisam de você hoje (fila travada, queda de agendamento)</span>
        </label>

        <label className="marca" htmlFor="enviarAviso">
          <input defaultChecked={preferencias?.enviarAviso ?? false} id="enviarAviso"
                 name="enviarAviso" type="checkbox" />
          <span>Sinais mais leves, para acompanhar de perto</span>
        </label>

        <label className="marca" htmlFor="enviarRetencao">
          <input defaultChecked={preferencias?.enviarRetencao ?? true} id="enviarRetencao"
                 name="enviarRetencao" type="checkbox" />
          <span>Clientes que a lei manda apagar por falta de contato</span>
        </label>

        <p className="ui-field__hint">
          Nada sai entre 21h e 8h, e o mesmo aviso não se repete no mesmo dia.
        </p>

        <button className="ui-button ui-button--primary ui-button--block" type="submit">
          Salvar
        </button>
      </form>
    </>
  );
}

const dataCurta = (iso: string): string =>
  new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
    .format(new Date(iso));
