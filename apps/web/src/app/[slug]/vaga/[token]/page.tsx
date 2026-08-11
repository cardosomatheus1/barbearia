import type { Metadata } from 'next';
import { convitePorToken, type EstadoDoConvite } from '@/lib/admin-api';
import { aceitar } from './acoes';

/**
 * O convite de vaga (bloco 39, SPEC §2.9).
 *
 * A pessoa entrou na lista de espera, um horário abriu e o produto a chamou
 * primeiro. Ela chega aqui pelo WhatsApp, sem sessão, com o relógio correndo: o
 * horário está **segurado** para ela por dez minutos e fora da grade de todo
 * mundo.
 *
 * Por isso a tela tem uma coisa só: o horário, e um botão. Nada de escolher
 * serviço, profissional ou hora — isso tudo já foi decidido quando ela entrou na
 * lista, e refazer a escolha aqui gastaria a exclusividade que ela ganhou.
 *
 * `noindex` pelo mesmo motivo do link da fila: o endereço carrega uma credencial.
 */

export const metadata: Metadata = {
  title: 'Um horário abriu para você',
  robots: { index: false, follow: false },
};

interface Props {
  readonly params: Promise<{ slug: string; token: string }>;
  readonly searchParams: Promise<{ erro?: string }>;
}

/**
 * O que dizer quando o convite já não vale.
 *
 * Cada estado tem uma frase própria porque cada um significa uma coisa
 * diferente para quem está lendo — e "não deu certo" para todos ensinaria a
 * pessoa a não confiar na mensagem seguinte.
 */
const ENCERRADO: Readonly<Record<Exclude<EstadoDoConvite, 'aberta'>, string>> = {
  aceitando: 'Estamos confirmando este horário. Recarregue em alguns segundos.',
  aceita: 'Este horário já é seu. Ele está em "Meus agendamentos".',
  vencida: 'O prazo para responder terminou e o horário voltou para a agenda.',
  cancelada: 'Você saiu desta lista de espera, então o convite não vale mais.',
};

const ERRO: Readonly<Record<string, string>> = {
  oferta_encerrada: 'Este convite já não vale. Recarregue para ver o que aconteceu.',
  oferta_nao_encontrada: 'Este convite não existe mais.',
  slot_taken: 'O horário foi preenchido antes da confirmação. Você continua na lista.',
  slot_not_available: 'O horário deixou de estar disponível. Você continua na lista.',
};

export default async function ConviteDeVagaPage({ params, searchParams }: Props) {
  const { slug, token } = await params;
  const { erro } = await searchParams;

  const convite = await convitePorToken(slug, token);

  if (!convite.ok) {
    return (
      <main className="ui-container convite">
        <h1 className="convite__titulo">Este convite não está mais válido</h1>
        <p className="convite__sub">
          Ele vale por poucos minutos, e só para quem está na lista de espera. Se você ainda
          quer um horário, dá para escolher um agora.
        </p>
        <a className="ui-button ui-button--secondary convite__alternativa" href={`/${slug}`}>
          Ver horários
        </a>
      </main>
    );
  }

  const vaga = convite.dados;
  // A frase do encerramento é calculada aqui, e não no JSX: é o que estreita o
  // estado para o compilador, e o que garante que um estado novo no domínio
  // apareça como erro de tipo em vez de sumir da tela.
  const encerrado = vaga.estado === 'aberta' ? null : ENCERRADO[vaga.estado];

  return (
    <main className="ui-container convite">
      <p className="convite__casa">{vaga.barbearia}</p>

      {encerrado === null ? (
        <>
          <p className="convite__rotulo">Abriu um horário para você</p>

          {/* O horário é o herói: é a única informação que decide o clique. */}
          <p className="convite__hora tabular">{vaga.hora}</p>
          <p className="convite__dia">{porExtenso(vaga.dia)}</p>

          <dl className="convite__dados">
            <div>
              <dt>Com</dt>
              <dd>{vaga.profissionalNome}</dd>
            </div>
            {vaga.servicos.length > 0 ? (
              <div>
                <dt>Serviço</dt>
                <dd>{vaga.servicos.join(' + ')}</dd>
              </div>
            ) : null}
          </dl>

          {/* O prazo é a razão de a tela existir, e por isso ele fica junto do
              botão — não no rodapé, onde ninguém lê antes de decidir. */}
          <p className="convite__prazo">
            Guardado para você por mais{' '}
            <strong>
              {vaga.minutosRestantes} {vaga.minutosRestantes === 1 ? 'minuto' : 'minutos'}
            </strong>
            . Depois disso ele volta para a agenda.
          </p>

          {erro ? (
            <p className="convite__erro" role="alert">
              {ERRO[erro] ?? 'Não deu para confirmar agora. Tente de novo.'}
            </p>
          ) : null}

          <form action={aceitar} className="convite__acao">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="token" value={token} />
            <button
              className="ui-button ui-button--primary ui-button--lg ui-button--block"
              type="submit"
            >
              Quero este horário
            </button>
          </form>

          <p className="convite__nota">
            Se não responder, o horário vai para a próxima pessoa da lista — e você continua
            esperando pelos próximos.
          </p>
        </>
      ) : (
        <>
          <h1 className="convite__titulo">
            {vaga.hora} de {porExtenso(vaga.dia)}
          </h1>
          <p className="convite__sub">{encerrado}</p>
          <a className="ui-button ui-button--secondary convite__alternativa" href={`/${slug}`}>
            Ver horários
          </a>
        </>
      )}
    </main>
  );
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

/**
 * `2026-09-08` vira `terça, 8 de setembro`.
 *
 * Montado à mão a partir da string, sem `toLocaleDateString`: a data já vem no
 * fuso da unidade, e deixar o navegador — ou o Node do servidor — reinterpretá-la
 * devolveria o dia anterior para todo o Brasil, que fica a oeste de Greenwich.
 */
function porExtenso(dia: string): string {
  const [ano = '', mes = '', data = ''] = dia.split('-');
  const semana = DIAS[new Date(`${dia}T12:00:00Z`).getUTCDay()] ?? '';
  return `${semana}, ${Number(data)} de ${MESES[Number(mes) - 1] ?? ''} de ${ano}`;
}
