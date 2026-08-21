import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { lerSessaoDaPlataforma } from '@/lib/sessao-plataforma';
import { acaoSairDaPlataforma } from './acoes';

/**
 * Painel da plataforma.
 *
 * Deliberadamente **não** reaproveita o casco do painel da barbearia. As duas
 * telas se parecem — fundo escuro, mesma tipografia, mesmos componentes —, e é
 * exatamente por isso que a barra tem que dizer, o tempo todo, que quem está
 * ali vê todas as barbearias. Um Super Admin que confunde as duas telas bloqueia
 * a conta errada.
 *
 * A moldura só aparece com sessão. Sem ela a tela de entrar fica nua, como as
 * portas do painel da barbearia.
 */

export const metadata: Metadata = {
  title: 'Plataforma',
  robots: { index: false, follow: false },
};

export default async function PlataformaLayout({ children }: { readonly children: ReactNode }) {
  const token = await lerSessaoDaPlataforma();

  if (!token) {
    return (
      <div className="painel painel--porta" data-theme="dark">
        {children}
      </div>
    );
  }

  return (
    <div className="painel plataforma" data-theme="dark">
      <header className="plataforma__barra">
        <div className="ui-container plataforma__barra-interna">
          <p className="plataforma__marca">
            Barber Dock
            <span className="plataforma__selo">plataforma</span>
          </p>

          <nav aria-label="Plataforma" className="plataforma__nav">
            <a className="plataforma__link" href="/plataforma">
              Barbearias
            </a>
            <a className="plataforma__link" href="/plataforma/metricas">
              Métricas
            </a>
            <a className="plataforma__link" href="/plataforma/assinaturas">
              Assinaturas
            </a>
            <a className="plataforma__link" href="/plataforma/faturas">
              Cobrança
            </a>
            <a className="plataforma__link" href="/plataforma/destaques">
              Destaques
            </a>
            <a className="plataforma__link" href="/plataforma/franquias">
              Franquias
            </a>
            <a className="plataforma__link" href="/plataforma/trilha">
              Trilha
            </a>
            <a className="plataforma__link" href="/plataforma/seguranca">
              Segurança
            </a>
          </nav>

          <form action={acaoSairDaPlataforma}>
            <button className="ui-button ui-button--ghost plataforma__sair" type="submit">
              Sair
            </button>
          </form>
        </div>
      </header>

      {children}
    </div>
  );
}
