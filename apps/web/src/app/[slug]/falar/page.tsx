import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ROTULO_DO_TIPO, TIPOS_DE_RECADO, MAXIMO_DO_RECADO } from '@barbearia/core';
import { getProfile } from '@/lib/api';
import { lerSessao } from '@/lib/sessao';
import { mandar } from './acoes';

/**
 * Fale com a barbearia (bloco 40).
 *
 * O outro lado da avaliação: quem quer dizer alguma coisa **sem ter uma nota
 * para dar**. "A cadeira do fundo está bamba", "vocês deviam abrir no domingo",
 * "esperei quarenta minutos". Nada disso cabe numa estrela.
 *
 * ## Sem conta, e sem nem pedir o nome
 *
 * É a decisão que faz o canal existir. A reclamação mais valiosa vem de quem
 * desistiu e foi embora, e essa pessoa não vai criar cadastro para reclamar.
 * Nome e celular ficam num bloco separado, explicitamente rotulado como "se
 * quiser resposta" — porque é exatamente isso que eles compram.
 *
 * ## Uma tela, um botão
 *
 * Três escolhas de tipo, um campo de texto e enviar. Sem estrelas, sem
 * categorias, sem "de 0 a 10 o quanto você recomendaria" — isso é o bloco 43, e
 * misturar os dois faria as duas coisas piores.
 */

export const metadata: Metadata = {
  title: 'Fale com a gente',
  robots: { index: false, follow: false },
};

interface Props {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<{ feito?: string; erro?: string; t?: string }>;
}

const ERRO: Readonly<Record<string, string>> = {
  texto_curto: 'Escreva um pouco mais — dez caracteres, pelo menos.',
  texto_longo: 'Ficou longo demais. Resuma um pouco.',
  tipo_invalido: 'Escolha sugestão, reclamação ou elogio.',
  invalid_request: 'Confira o celular: precisa ter DDD e nove dígitos.',
  establishment_not_found: 'Esta barbearia não está mais disponível.',
};

/** O que cada tipo convida a escrever. Rótulo genérico não puxa nada de ninguém. */
const CONVITE: Readonly<Record<string, string>> = {
  sugestao: 'O que a gente podia fazer melhor?',
  reclamacao: 'O que deu errado?',
  elogio: 'O que foi bom?',
};

export default async function FalarPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { feito, erro, t } = await searchParams;

  const perfil = await getProfile(slug);
  if (!perfil) notFound();

  const temSessao = Boolean(await lerSessao(slug));
  const escolhido = t && TIPOS_DE_RECADO.includes(t as never) ? t : 'sugestao';

  if (feito) {
    return (
      <main className="ui-container falar">
        <p className="falar__casa">{perfil.name}</p>
        <h1 className="falar__titulo">Recebemos seu recado</h1>
        <p className="falar__sub">
          Alguém da equipe lê tudo o que chega por aqui. Se você deixou seu celular, a resposta
          vem por lá.
        </p>
        <a className="ui-button ui-button--secondary falar__voltar" href={`/${slug}`}>
          Voltar para {perfil.name}
        </a>
      </main>
    );
  }

  return (
    <main className="ui-container falar">
      {/* Toda tela tem volta (CLAUDE.md §6). Sem isto, quem abre o canal pela
          página pública e desiste de escrever fica sem caminho de saída — e no
          celular a única alternativa é o botão do sistema. */}
      <a className="voltar falar__voltar-topo" href={`/${slug}`}>
        ← {perfil.name}
      </a>
      <h1 className="falar__titulo">Fale com a gente</h1>
      <p className="falar__sub">
        Sugestão, reclamação ou elogio — o que você escrever chega direto para a equipe, e não
        aparece em lugar nenhum público.
      </p>

      {erro ? (
        <p className="falar__erro" role="alert">
          {ERRO[erro] ?? 'Não deu para enviar agora. Tente de novo.'}
        </p>
      ) : null}

      <form action={mandar} className="falar__form">
        <input type="hidden" name="slug" value={slug} />

        <fieldset className="falar__tipos">
          <legend className="falar__rotulo">O que você quer dizer</legend>
          {TIPOS_DE_RECADO.map((tipo) => (
            <label className="falar__tipo" key={tipo}>
              <input
                defaultChecked={tipo === escolhido}
                name="tipo"
                type="radio"
                value={tipo}
              />
              <span>{ROTULO_DO_TIPO[tipo]}</span>
            </label>
          ))}
        </fieldset>

        <label className="falar__campo">
          <span className="falar__rotulo">{CONVITE[escolhido] ?? 'Conte para a gente'}</span>
          <textarea
            className="falar__texto"
            maxLength={MAXIMO_DO_RECADO}
            minLength={10}
            name="texto"
            required
            rows={6}
          />
        </label>

        {/* O contato é o que compra a resposta, e a tela diz isso com todas as
            letras. Pedi-lo como obrigatório perderia quem só quer avisar. */}
        {temSessao ? (
          <p className="falar__nota">
            Você está identificado — a resposta chega no seu WhatsApp.
          </p>
        ) : (
          <fieldset className="falar__contato">
            <legend className="falar__rotulo">Se quiser resposta</legend>
            <label className="falar__campo">
              <span>Seu nome</span>
              <input autoComplete="name" className="ui-field__input" name="nome" type="text" />
            </label>
            <label className="falar__campo">
              <span>Celular com DDD</span>
              <input
                autoComplete="tel"
                className="ui-field__input"
                inputMode="tel"
                name="telefone"
                type="tel"
              />
            </label>
            <p className="falar__nota">
              Sem isso o recado chega igual — só não tem para onde responder.
            </p>
          </fieldset>
        )}

        <button className="ui-button ui-button--primary ui-button--block" type="submit">
          Enviar
        </button>
      </form>
    </main>
  );
}
