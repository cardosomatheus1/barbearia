import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { diagnosticoDoCatalogo, type AchadoDoCatalogo } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoSair } from '../../acoes';
import { CadastroNav } from '../../cadastro-nav';

/**
 * Diagnóstico do catálogo — SPEC §5.7, que resolve D4 e D5.
 *
 * A tela existe para uma coisa: transformar o achado em conserto. Por isso cada
 * item traz **o que fazer** logo abaixo do que está errado, e um link para a
 * linha do cadastro — não para uma lista onde a pessoa procura de novo.
 *
 * A ordem é por consequência, não por regra: o que quebra a agenda vem antes do
 * que deixa a página feia. Um dono que abre isto tem quinze minutos, e os
 * quinze minutos precisam render.
 */

export const metadata: Metadata = {
  title: 'Diagnóstico do catálogo',
  robots: { index: false, follow: false },
};

const ROTULO = {
  bloqueia: 'Atrapalha a agenda',
  publicacao: 'Some da sua página',
  aviso: 'Dá para melhorar',
} as const;

const ORDEM = { bloqueia: 0, publicacao: 1, aviso: 2 } as const;

/**
 * A classe é `defeito`, não `achado`, apesar de o tipo se chamar `Achado`.
 *
 * `.achado` já é a linha de resultado da busca de cliente no balcão — flex, uma
 * linha, alinhada ao centro. Reaproveitar o nome aqui, onde o item é um bloco de
 * três parágrafos, herdaria aquele layout em silêncio e a tela quebraria sem
 * ninguém mudar uma linha desta pasta.
 */
function Defeito({ achado }: { readonly achado: AchadoDoCatalogo }) {
  return (
    <li className={`defeito defeito--${achado.severidade}`}>
      <p className="defeito__selo">{ROTULO[achado.severidade]}</p>
      <p className="defeito__titulo">{achado.titulo}</p>
      <p className="defeito__conserto">{achado.conserto}</p>
      <a className="defeito__link" href="/admin/catalogo">
        Abrir o cadastro
      </a>
    </li>
  );
}

export default async function DiagnosticoPage() {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const resposta = await diagnosticoDoCatalogo(token);

  const topo = (
    <header className="painel__topo">
      <a className="painel__marca" href="/admin/painel">
        ← {estado.businessName}
      </a>
      <form action={acaoSair}>
        <button className="ui-button ui-button--ghost painel__sair" type="submit">
          Sair
        </button>
      </form>
    </header>
  );

  if (!resposta.ok) {
    return (
      <main className="ui-container painel__conteudo" data-secao="cadastro">
        {topo}
        <h1 className="painel__titulo">Diagnóstico do catálogo</h1>
        <div className="ui-alert ui-alert--warning" role="alert">
          {resposta.code === 'forbidden'
            ? 'Sua conta não mexe no cadastro.'
            : 'Não deu para conferir agora. Tente de novo.'}
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">
            Voltar ao dia
          </a>
        </div>
      </main>
    );
  }

  const { achados, resumo, examinados } = resposta.dados;
  const ordenados = [...achados].sort((a, b) => ORDEM[a.severidade] - ORDEM[b.severidade]);

  return (
    <main className="ui-container painel__conteudo" data-secao="cadastro">
      {topo}
      <CadastroNav atual="/admin/catalogo/diagnostico" />

      <h1 className="painel__titulo">Diagnóstico do catálogo</h1>
      <p className="painel__sub">
        {examinados === 0
          ? 'Nenhum serviço cadastrado ainda.'
          : `${examinados} ${examinados === 1 ? 'serviço conferido' : 'serviços conferidos'}, mais os combos e as jornadas.`}
      </p>

      {achados.length === 0 ? (
        <div className="vazio">
          <p className="vazio__titulo">
            {examinados === 0 ? 'Nada para conferir ainda' : 'Está tudo certo'}
          </p>
          <p className="vazio__saida">
            {examinados === 0
              ? 'Cadastre os serviços e volte aqui — a conferência roda sozinha a cada mudança.'
              : 'Duração dos combos, categorias, preços, fotos e jornadas: nada fora do lugar.'}
          </p>
          <a className="ui-button ui-button--secondary" href="/admin/catalogo">
            Ver o cardápio
          </a>
        </div>
      ) : (
        <>
          <dl className="numeros">
            <div className="numero">
              <dt className="numero__rotulo">Atrapalha a agenda</dt>
              <dd className="numero__valor tabular">{resumo.bloqueia}</dd>
            </div>
            <div className="numero">
              <dt className="numero__rotulo">Some da página</dt>
              <dd className="numero__valor tabular">{resumo.publicacao}</dd>
            </div>
            <div className="numero">
              <dt className="numero__rotulo">Dá para melhorar</dt>
              <dd className="numero__valor tabular">{resumo.aviso}</dd>
            </div>
          </dl>

          <ul className="defeitos">
            {ordenados.map((achado) => (
              <Defeito achado={achado} key={`${achado.regra}-${achado.alvoId ?? achado.alvoNome}`} />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
