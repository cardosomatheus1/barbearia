import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { getProfile, type EntendidoAteAqui, type RespostaDoAgente } from '@/lib/api';

/**
 * A porta do agente de conversa (blocos 65 e 66, SPEC §4.16 e §4.17).
 *
 * ## Por que esta tela existe
 *
 * O motor e as duas rotas estavam de pé desde o bloco 66 — intenção, casamento
 * de serviço contra o catálogo, três horários pelo mesmo motor da página
 * pública, recepção que só responde o que a barbearia cadastrou — e **ninguém
 * conseguia falar com eles**. Nenhum helper da web os chamava, não havia tela, e
 * o webhook da Meta encaminha mensagem recebida para outro lugar. Era o defeito
 * de `blocks` na sua forma mais cara: motor completo, testado, e sem porta.
 *
 * ## Uma conversa sem componente de cliente
 *
 * Este produto não manda JavaScript próprio para o navegador, então não há
 * balões nem digitação ao vivo. O que a tela faz é o que uma conversa faz de
 * útil: a pessoa escreve em português e recebe uma resposta — com os horários
 * como links, quando há.
 *
 * A resposta volta por **cookie de dois minutos**, não pela URL. O motivo está
 * escrito em `acoes.ts`: quem escreve aqui é o cliente final, numa página
 * pública, e a frase pode conter o nome e o telefone dele.
 *
 * ## Ela não grava nada, e isso é o desenho
 *
 * Cada horário oferecido é um link para o **passo 4** do agendamento de sempre.
 * A gravação continua no `POST` que tem `Idempotency-Key`, sinal, score e a
 * constraint anti-overbooking. Um segundo caminho de escrita teria metade das
 * garantias — é a mesma razão de a rota do agente não gravar.
 */

export const metadata: Metadata = {
  title: 'Conversar',
  robots: { index: false, follow: false },
};

interface Props {
  readonly params: Promise<{ slug: string }>;
}

const hora = (iso: string, fuso: string): string =>
  new Date(iso).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: fuso,
  });

/**
 * O que o agente já entendeu, em português — e só o que ele **de fato** entendeu.
 *
 * O objeto tem cinco campos e quase sempre a maioria é nula: listar todos daria
 * "serviço: nenhum, profissional: nenhum", que é ruído com cara de resposta. O
 * que serve é confirmar o que foi captado, para a pessoa saber o que não
 * precisa repetir.
 */
function jaEntendi(entendido: EntendidoAteAqui): string | null {
  const partes: string[] = [];
  if (entendido.servico) partes.push(entendido.servico);
  if (entendido.profissional) partes.push(`com ${entendido.profissional}`);
  if (entendido.emQuantosDias === 0) partes.push('hoje');
  else if (entendido.emQuantosDias === 1) partes.push('amanhã');
  else if (entendido.emQuantosDias !== null) partes.push(`em ${entendido.emQuantosDias} dias`);
  if (entendido.aPartirDeMinuto !== null) partes.push(`a partir das ${daMeiaNoite(entendido.aPartirDeMinuto)}`);
  if (entendido.ateMinuto !== null) partes.push(`até as ${daMeiaNoite(entendido.ateMinuto)}`);
  return partes.length > 0 ? partes.join(', ') : null;
}

/** Minutos locais desde a meia-noite, que é como o domínio inteiro fala de hora. */
const daMeiaNoite = (minuto: number): string =>
  `${String(Math.floor(minuto / 60)).padStart(2, '0')}:${String(minuto % 60).padStart(2, '0')}`;

const dia = (data: string): string =>
  new Date(`${data}T12:00:00Z`).toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    timeZone: 'UTC',
  });

/**
 * Três exemplos, e não uma lista de comandos.
 *
 * Uma caixa de texto vazia numa tela nova é a pergunta "o que eu posso escrever
 * aqui?", e quem não sabe fecha. Os exemplos são frases inteiras de propósito:
 * mostram que dá para escrever como se fala, que é a única vantagem que este
 * caminho tem sobre a grade.
 */
const EXEMPLOS = [
  'Quero cortar o cabelo amanhã de tarde',
  'Vocês abrem no domingo?',
  'Quanto custa a barba?',
];

export default async function ConversarPage({ params }: Props) {
  const { slug } = await params;
  const perfil = await getProfile(slug);
  if (!perfil) notFound();

  const bruto = (await cookies()).get('conversa')?.value;
  let conversa: { texto: string; resposta: RespostaDoAgente } | null = null;
  if (bruto) {
    try {
      conversa = JSON.parse(bruto) as { texto: string; resposta: RespostaDoAgente };
    } catch {
      // Cookie ilegível é conversa perdida, não erro para o cliente: a tela
      // volta ao estado de quem acabou de chegar.
      conversa = null;
    }
  }

  return (
    <main className="ui-container conversar">
      {/* Toda tela tem volta (§6, pergunta 1). */}
      <a className="voltar" href={`/${slug}`}>
        ← {perfil.name}
      </a>

      <h1 className="conversar__titulo">Escreva o que você precisa</h1>
      <p className="conversar__sub">
        Em português mesmo, como você diria no balcão. Se der para marcar, os horários aparecem
        aqui — e quem confirma é você, na tela de sempre.
      </p>

      {conversa ? (
        <div className="conversar__troca">
          <p className="conversar__voce">{conversa.texto}</p>
          <Resposta
            fuso={perfil.location.timezone}
            resposta={conversa.resposta}
            slug={slug}
          />
        </div>
      ) : (
        <ul className="conversar__exemplos">
          {EXEMPLOS.map((frase) => (
            <li key={frase}>{frase}</li>
          ))}
        </ul>
      )}

      {/* `method="post"` puro para um route handler, e não uma server action.

          A action foi tentada e não serve: o cookie é gravado no `jar` do
          servidor, a ação roda até o fim, e nenhum `Set-Cookie` sai na resposta
          — conferido com `curl -D` contra o `next start` deste repositório. O
          handler devolve uma resposta HTTP de verdade, e ali o cookie é cookie.

          De quebra o formulário fica sendo o que ele parece: um `<form>` que
          envia, sem depender de JavaScript nenhum. */}
      <form action={`/${slug}/conversar/perguntar`} className="conversar__form" method="post">
        <label className="conversar__campo">
          <span className="ui-field__label">
            {conversa ? 'Escreva de novo' : 'O que você precisa?'}
          </span>
          <textarea
            className="ui-field__input conversar__texto"
            maxLength={500}
            name="texto"
            required
            rows={3}
          />
        </label>
        <button className="ui-button ui-button--primary ui-button--block" type="submit">
          Enviar
        </button>
      </form>

      {/* A saída para gente é permanente, não só quando o agente desiste: quem
          quer falar com pessoa não deveria ter que convencer um robô primeiro. */}
      <p className="conversar__saida">
        Prefere falar com a equipe? <a href={`/${slug}/falar`}>Deixe um recado</a>.
      </p>
    </main>
  );
}

/**
 * Um caso por vez, derivado da união que a API devolve.
 *
 * A alternativa — um objeto de campos opcionais e uma sequência de `if`s sobre
 * eles — é como um "não entendi" apareceria ao lado de três horários: nada no
 * tipo impediria os dois de existirem juntos.
 */
function Resposta({
  resposta,
  slug,
  fuso,
}: {
  resposta: RespostaDoAgente;
  slug: string;
  fuso: string;
}) {
  if (!resposta.entendi) {
    /**
     * "Não entendi" é resposta legítima, e vem com saída.
     *
     * Um palpite que parece certo para a pergunta errada é o pior desfecho de um
     * assistente. E a pergunta que ninguém soube responder já virou linha na
     * lista do dono — é o produto da recepção digital.
     */
    return (
      <div className="conversar__resposta">
        <p>Não entendi esse. Pode escrever de outro jeito?</p>
        <p className="conversar__nota">
          Se for algo que só a equipe resolve, <a href={`/${slug}/falar`}>deixe um recado</a> —
          alguém lê tudo o que chega por lá.
        </p>
      </div>
    );
  }

  if (resposta.escalar) {
    return (
      <div className="conversar__resposta">
        <p>Claro. Deixe um recado que alguém da equipe responde.</p>
        <a className="ui-button ui-button--secondary" href={`/${slug}/falar`}>
          Falar com a equipe
        </a>
      </div>
    );
  }

  if ('resposta' in resposta) {
    return (
      <div className="conversar__resposta">
        <p>{resposta.resposta}</p>
      </div>
    );
  }

  if ('precisaEntrar' in resposta) {
    /**
     * Remarcar e cancelar exigem saber **qual** horário, e isso exige sessão.
     * A tela manda para a porta certa em vez de pedir o id — um id de
     * agendamento numa página pública é o caminho para mexer no alheio.
     */
    return (
      <div className="conversar__resposta">
        <p>Para mexer num horário que já existe, entre com seu celular.</p>
        <a className="ui-button ui-button--primary" href={`/${slug}/entrar`}>
          Entrar
        </a>
      </div>
    );
  }

  if ('pergunta' in resposta) {
    const captado = jaEntendi(resposta.entendido);
    return (
      <div className="conversar__resposta">
        <p>{resposta.pergunta}</p>
        {captado ? <p className="conversar__nota">Até aqui entendi: {captado}.</p> : null}
      </div>
    );
  }

  if (resposta.nenhumServe) {
    /**
     * Vazio é uma tela, não uma lista vazia: diz o motivo e o que fazer.
     * A grade completa é a saída — ela mostra os outros dias.
     */
    return (
      <div className="conversar__resposta">
        <p>Não achei horário assim em {dia(resposta.data)}.</p>
        {/* A saída leva o serviço junto: recomeçar do zero seria a conversa
            jogada fora justamente para quem já não achou o que queria. */}
        <a
          className="ui-button ui-button--primary"
          href={`/${slug}/agendar?s=${resposta.servicoId}&e=p`}
        >
          Ver a agenda completa
        </a>
      </div>
    );
  }

  return (
    <div className="conversar__resposta">
      <p>{dia(resposta.data)}, tenho estes:</p>
      <ul className="conversar__horarios">
        {resposta.horarios.map((h) => (
          <li key={h.comecaEm}>
            {/* O link leva ao passo 4 do agendamento de sempre. É lá que a
                confirmação acontece, com o preço do motor, o sinal e a chave de
                idempotência — o agente propõe, a página grava. */}
            <a
              className="hora"
              href={`/${slug}/agendar?s=${resposta.servicoId}&p=${h.profissionalId}`
                + `&d=${resposta.data}&h=${encodeURIComponent(hora(h.comecaEm, fuso))}&e=d`}
            >
              <span className="hora__valor tabular">{hora(h.comecaEm, fuso)}</span>
            </a>
          </li>
        ))}
      </ul>
      <p className="conversar__nota">
        <a href={`/${slug}/agendar?s=${resposta.servicoId}&e=p`}>Ver todos os horários</a>
      </p>
    </div>
  );
}
