import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { segundoFator } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import {
  lerCodigosDeRecuperacao,
  lerSegredoDoMfa,
  lerSessaoGestor,
} from '@/lib/sessao-gestor';
import {
  acaoComecarSegundoFator,
  acaoConfirmarSegundoFator,
  acaoSair,
  acaoVerificarSegundoFator,
} from '../acoes';

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
      <main className="ui-container painel__conteudo">
        {topo}
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[mfa.code] ?? FALHA['request_failed']} <a href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const { ativo, pendente, obrigatorio, verificadoNestaSessao } = mfa.dados;

  return (
    <main className="ui-container painel__conteudo">
      {topo}

      <h1 className="painel__titulo">Segundo fator</h1>
      <p className="painel__sub">
        Um código de seis dígitos, do aplicativo do seu celular, para quem mexe em dinheiro. O
        balcão fica logado o dia inteiro — o código é o que separa a gaveta de quem passa por perto.
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
              : 'Sua conta ainda não mexe em dinheiro, mas ligar o segundo fator protege o cadastro e a equipe.'}
          </p>
          <form action={acaoComecarSegundoFator}>
            <button className="ui-button ui-button--primary ui-button--block" type="submit">
              Gerar chave
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
