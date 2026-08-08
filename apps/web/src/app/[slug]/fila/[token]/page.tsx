import type { Metadata } from 'next';
import { minhaPosicaoNaFila } from '@/lib/admin-api';
import { getProfile } from '@/lib/api';

/**
 * Minha posição na fila.
 *
 * A SPEC (Parte 2 §2.10) pede que a pessoa acompanhe a posição pelo celular,
 * **por link, sem app**. Esta é a tela que sustenta isso — e é a única do
 * produto sem sessão nenhuma: o token no endereço é a credencial.
 *
 * O que ela mostra é o mínimo. Nenhum nome de outra pessoa, nenhum telefone,
 * nenhuma lista. Quem tem o link tem o link dele, não a fila da barbearia —
 * porque um link de acompanhamento acaba num grupo de família em dois toques.
 *
 * `noindex` não é detalhe: uma página com nome de cliente e posição na fila
 * indexada pelo Google seria vazamento com endereço permanente.
 */

export const metadata: Metadata = {
  title: 'Sua posição na fila',
  robots: { index: false, follow: false },
};

interface Props {
  readonly params: Promise<{ slug: string; token: string }>;
}

export default async function MinhaFilaPage({ params }: Props) {
  const { slug, token } = await params;

  const [posicao, perfil] = await Promise.all([
    minhaPosicaoNaFila(slug, token),
    getProfile(slug),
  ]);

  const nomeDaCasa = perfil?.name ?? 'a barbearia';

  if (!posicao.ok) {
    return (
      <main className="ui-container vazio-pagina fila-cliente">
        <h1 className="fila-cliente__titulo">Este link não está mais válido</h1>
        <p className="fila-cliente__sub">
          Ele vale enquanto você está na fila. Se ainda estiver esperando, fale com a recepção —
          eles conseguem gerar outro.
        </p>
        <a className="ui-button ui-button--secondary" href={`/${slug}`}>
          Ver {nomeDaCasa}
        </a>
      </main>
    );
  }

  const minha = posicao.dados;
  const naFila = minha.status === 'waiting' || minha.status === 'called';

  return (
    <main className="ui-container fila-cliente">
      <p className="fila-cliente__casa">{nomeDaCasa}</p>

      {naFila ? (
        <>
          {/* O número é o herói da tela: é a única coisa que a pessoa abre o
              celular para ver, muitas vezes de relance, na rua. */}
          <p className="fila-cliente__rotulo">Sua posição</p>
          <p className="fila-cliente__numero tabular" aria-label={`Posição ${minha.posicao}`}>
            {minha.posicao}
          </p>
          <p className="fila-cliente__frase">{minha.frase}</p>

          <dl className="fila-cliente__dados">
            <div>
              <dt>Você</dt>
              <dd>{minha.nome}</dd>
            </div>
            {minha.services.length > 0 ? (
              <div>
                <dt>Serviço</dt>
                <dd>{minha.services.join(' + ')}</dd>
              </div>
            ) : null}
            {minha.professionalName ? (
              <div>
                <dt>Com</dt>
                <dd>{minha.professionalName}</dd>
              </div>
            ) : null}
          </dl>

          <p className="fila-cliente__nota">
            Esta página não se atualiza sozinha — recarregue para ver a posição do momento. A
            estimativa muda a cada atendimento que termina.
          </p>
        </>
      ) : (
        <>
          <p className="fila-cliente__rotulo">{minha.nome}</p>
          <p className="fila-cliente__frase fila-cliente__frase--grande">{minha.frase}</p>
          <a className="ui-button ui-button--secondary" href={`/${slug}`}>
            Marcar um horário
          </a>
        </>
      )}
    </main>
  );
}
