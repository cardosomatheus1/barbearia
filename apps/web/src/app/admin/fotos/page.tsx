import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { estadoDoPainel, fotosDaBarbearia, type AlvosDeFoto } from '@/lib/admin-api';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoFotos, acaoSair } from '../acoes';

/**
 * Fotos da barbearia.
 *
 * As colunas `cover_url`, `photo_url` e `logo_url` existiam desde o bloco 1 e o
 * perfil público já as devolvia. **Nunca houve por onde preenchê-las** — e o
 * resultado era uma página de barbearia sem uma única imagem, num negócio em
 * que a escolha do cliente é visual antes de ser qualquer outra coisa.
 *
 * Enquanto não há armazenamento próprio (bloco declarado no ROADMAP), o
 * endereço é colado: a barbearia já tem as fotos publicadas em algum lugar. É
 * uma etapa a menos que esperar por infraestrutura de upload para a página
 * deixar de parecer um cardápio de texto.
 */

export const metadata: Metadata = {
  title: 'Fotos',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

function Campo({
  nome,
  rotulo,
  valor,
  dica,
}: {
  readonly nome: string;
  readonly rotulo: string;
  readonly valor: string | null;
  readonly dica?: string;
}) {
  return (
    <div className="ui-field foto-campo">
      <label className="ui-field__label" htmlFor={nome}>
        {rotulo}
      </label>
      <div className="foto-campo__linha">
        {valor ? (
          // eslint-disable-next-line @next/next/no-img-element -- endereço externo
          // arbitrário; `next/image` exigiria cadastrar cada domínio de antemão.
          <img className="foto-campo__mini" src={valor} alt="" width={96} height={96} />
        ) : (
          <span className="foto-campo__mini foto-campo__mini--vazia" aria-hidden="true" />
        )}
        <input
          className="ui-field__input"
          id={nome}
          name={nome}
          type="url"
          inputMode="url"
          defaultValue={valor ?? ''}
          placeholder="https://..."
          maxLength={500}
          autoComplete="off"
        />
      </div>
      {dica ? <p className="ui-field__hint">{dica}</p> : null}
    </div>
  );
}

export default async function FotosPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await estadoDoPainel(token);
  if (!estado.ok) redirect('/admin/entrar');

  const resposta = await fotosDaBarbearia(token);
  const query = await searchParams;
  const salvo = first(query['salvo']) === '1';

  if (!resposta.ok) {
    return (
      <main className="ui-container painel__conteudo">
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar as fotos. <a href="/admin/fotos">Tentar de novo</a>
        </div>
      </main>
    );
  }

  const fotos: AlvosDeFoto = resposta.dados;
  const preenchidas =
    (fotos.coverUrl ? 1 : 0) +
    fotos.professionals.filter((p) => p.photoUrl).length +
    fotos.services.filter((s) => s.photoUrl).length;

  return (
    <main className="ui-container painel__conteudo">
      <header className="painel__topo">
        <a className="painel__marca" href="/admin/dia">← {estado.dados.businessName}</a>
        <form action={acaoSair}>
          <button className="ui-button ui-button--ghost painel__sair" type="submit">
            Sair
          </button>
        </form>
      </header>

      <h1 className="painel__titulo">Fotos</h1>
      <p className="painel__sub">
        Cole o endereço de fotos que você já publicou. Elas aparecem na sua página, que hoje é
        só texto — e em barbearia a escolha do cliente é visual.
      </p>

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Fotos salvas. {preenchidas === 0 ? 'Nenhuma foi aceita — confira se o endereço começa com https://.' : null}{' '}
          <a href={`/${estado.dados.slug}`} rel="noopener noreferrer" target="_blank">
            Ver a página
          </a>
        </div>
      ) : null}

      <form action={acaoFotos} className="formulario">
        <fieldset className="painel__grupo">
          <legend className="rotulo">A barbearia</legend>
          <Campo
            nome="coverUrl"
            rotulo="Foto do ambiente"
            valor={fotos.coverUrl}
            dica="A que mostra o salão. Aparece logo abaixo dos horários de hoje."
          />
          <Campo
            nome="logoUrl"
            rotulo="Logo"
            valor={fotos.logoUrl}
            dica="Opcional. Usada no cabeçalho e no compartilhamento."
          />
        </fieldset>

        {fotos.professionals.length > 0 ? (
          <fieldset className="painel__grupo">
            <legend className="rotulo">Quem atende</legend>
            <p className="ui-field__hint">
              O cliente escolhe barbeiro por rosto. Sem foto, esta seção é uma lista de nomes.
            </p>
            {fotos.professionals.map((pessoa) => (
              <Campo
                key={pessoa.id}
                nome={`pro_${pessoa.id}`}
                rotulo={pessoa.name}
                valor={pessoa.photoUrl}
              />
            ))}
          </fieldset>
        ) : null}

        {fotos.services.length > 0 ? (
          <fieldset className="painel__grupo">
            <legend className="rotulo">Serviços</legend>
            <p className="ui-field__hint">
              A foto do resultado vende melhor que a descrição. Deixe em branco o que não tiver.
            </p>
            {fotos.services.map((servico) => (
              <Campo
                key={servico.id}
                nome={`srv_${servico.id}`}
                rotulo={servico.name}
                valor={servico.photoUrl}
              />
            ))}
          </fieldset>
        ) : null}

        <div className="ui-sticky-action">
          <button className="ui-button ui-button--primary ui-button--block" type="submit">
            Salvar fotos
          </button>
        </div>
      </form>

      <p className="painel__nota">
        Endereço precisa começar com <code>https://</code>. O que não for aceito volta em branco —
        não é erro seu, é o navegador que bloquearia a imagem.
      </p>
    </main>
  );
}
