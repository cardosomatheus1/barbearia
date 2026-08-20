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
  acaoPoliticaDeSegundoFator,
  acaoConfirmarSegundoFator,
  acaoEncerrarSessao,
  acaoExpulsarSuporte,
  acaoPreferenciasDeAlerta,
  acaoSair,
  acaoVerificarSegundoFator,
} from '../acoes';
import { secao } from '../secoes';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';

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

  const { ativo, pendente, obrigatorio, verificadoNestaSessao } = mfa.dados;
  const { exigidoNaBarbearia, podeMudarAExigencia } = mfa.dados;
  const politica = first(query['politica']);

  return (
    <main className="ui-container painel__conteudo" {...secao('seguranca')}>
      {topo}

      <h1 className="painel__titulo">Segurança</h1>
      <p className="painel__sub">
        Um código de seis dígitos, do aplicativo do seu celular. O balcão fica logado o dia
        inteiro — o código é o que separa a gaveta de quem passa por perto.
      </p>

      {erro ? (
        <AvisoDeRecusa erro={erro} mapa={FALHA} className="painel__aviso" />
      ) : null}

      {politica ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          {politica === 'ligada'
            ? 'Pronto. Quem mexe em dinheiro passa a precisar do código — avise a equipe antes do próximo turno.'
            : 'Pronto. O financeiro deixou de pedir o código. Quem já ativou o segundo fator continua com ele.'}
        </div>
      ) : null}

      {/*
        A decisão da barbearia (bloco 37).

        Fica **no topo** e antes do cadastro da própria conta porque é a
        pergunta que vem primeiro: sem saber se a casa exige, "ativar segundo
        fator" é uma escolha sem contexto. Antes deste interruptor a exigência
        era imposta a toda barbearia no primeiro dia — e o resultado não era
        mais segurança, era a recepção operando na conta do dono.

        Só quem pode mudar vê o formulário. Para o resto é uma frase, e não um
        botão que responde 403.
      */}
      <section className="cartao-seguranca">
        <h2 className="cartao-seguranca__titulo">Exigir o código no financeiro</h2>
        <p className="cartao-seguranca__texto">
          {exigidoNaBarbearia
            ? 'Hoje, quem tem acesso a caixa, faturamento ou comissão precisa do código para operar. É a proteção mais forte que o produto tem.'
            : 'Hoje o financeiro não pede o código. Qualquer pessoa da equipe com permissão de dinheiro abre o caixa direto — e quem ficar logado no balcão continua logado.'}
        </p>

        {podeMudarAExigencia ? (
          <form action={acaoPoliticaDeSegundoFator}>
            <input name="exigir" type="hidden" value={exigidoNaBarbearia ? '0' : '1'} />

            {/*
              Desligar pede o código; ligar, não.

              A assimetria veio de um achado da revisão de segurança: como
              `team.manage` não é permissão de dinheiro, a API não cobrava
              segundo fator nenhum aqui — e uma sessão esquecida aberta no
              balcão desligava a proteção com um toque. Cobrar para **aumentar**
              a proteção seria o laço fechado ao contrário.

              O campo só aparece para quem tem o segundo fator cadastrado e
              ainda não provou nesta sessão: quem acabou de abrir o caixa não
              digita de novo, e quem nunca cadastrou não tem o que digitar.
            */}
            {exigidoNaBarbearia && ativo && !verificadoNestaSessao ? (
              <div className="ui-field">
                <label className="ui-field__label" htmlFor="codigoPolitica">
                  Código do segundo fator
                </label>
                <input autoComplete="one-time-code" className="ui-field__input tabular"
                       id="codigoPolitica" inputMode="numeric" maxLength={6} minLength={6}
                       name="codigo" pattern="[0-9]{6}" required type="text" />
                <p className="ui-field__hint">
                  Desligar a proteção do caixa pede o código — do mesmo jeito que desligar o
                  segundo fator de uma conta pede.
                </p>
              </div>
            ) : null}

            {/*
              Nunca primário, e desabilitado enquanto o próprio dono não tem o
              segundo fator (bloco 104).

              Antes, este botão era o **primeiro** âmbar cheio da tela, e o
              "Passo 1: gerar a chave" — de que ele depende — ficava abaixo. Quem
              clica no primeiro botão primário que vê liga a exigência para a
              barbearia inteira, e toda rota `finance.*` e `cashier.*` passa a
              responder `mfa_setup_required` para a equipe no meio do expediente.
              É literalmente o cenário que o `CLAUDE.md` descreve como motivo de
              o interruptor existir.

              O domínio só exige código para **afrouxar**; ligar não conferia
              nada. A tela passa a conferir, e diz por quê em vez de só recusar.
            */}
            <button
              className="ui-button ui-button--secondary ui-button--block"
              disabled={!exigidoNaBarbearia && !ativo}
              type="submit"
            >
              {exigidoNaBarbearia ? 'Deixar de exigir' : 'Passar a exigir'}
            </button>
            {!exigidoNaBarbearia && !ativo ? (
              <p className="cartao-seguranca__texto">
                Cadastre o seu segundo fator primeiro, logo abaixo. Ligar a exigência sem ter o
                seu deixaria você de fora do próprio financeiro.
              </p>
            ) : null}
          </form>
        ) : (
          <p className="cartao-seguranca__texto">
            Quem muda isso é o dono da barbearia.
          </p>
        )}
      </section>

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
              ? 'Sua conta tem acesso ao financeiro e esta barbearia exige o código: sem ele o caixa não abre.'
              : 'Nada obriga a sua conta a isto hoje — mas ligar o segundo fator protege o cadastro e a equipe.'}
          </p>
          <form action={acaoComecarSegundoFator}>
            <button className="ui-button ui-button--primary ui-button--block" type="submit">
              Gerar chave
            </button>
          </form>
        </section>
      )}

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

/**
 * Com **hora**, porque sem ela as sessões são indistinguíveis (bloco 104).
 *
 * A tela existe para responder "qual destes não sou eu?", e mostrava quatro
 * linhas iguais: "Aparelho desconhecido · Entrou em 19/08/26". O timestamp
 * completo já vinha da API e era jogado fora no formato. É o mesmo formato da
 * trilha, que acerta desde sempre.
 */
const dataCurta = (iso: string): string =>
  new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  })
    .format(new Date(iso));
