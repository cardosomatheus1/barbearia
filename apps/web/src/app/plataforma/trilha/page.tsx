import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { listarBarbearias, trilhaDaPlataforma, type EventoDaPlataforma } from '@/lib/plataforma-api';
import { lerSessaoDaPlataforma } from '@/lib/sessao-plataforma';

/**
 * A trilha da plataforma.
 *
 * Separada da trilha de cada barbearia porque o que se registra aqui não
 * pertence a nenhuma delas: bloquear conta e trocar plano são decisões da
 * plataforma sobre a barbearia, e continuam valendo mesmo depois que ela sai.
 *
 * O nome da barbearia é resolvido na tela a partir da lista, e não gravado no
 * evento: o nome muda, o `tenant_id` não. Gravar o nome no detalhe faria a
 * trilha mentir no dia da primeira renomeação.
 */

export const metadata: Metadata = {
  title: 'Trilha da plataforma',
  robots: { index: false, follow: false },
};

const ACAO: Record<string, string> = {
  'tenant.blocked': 'bloqueou',
  // A alíquota do split (bloco 49): termo comercial nosso, mudado por nós.
  'tenant.split_fee_changed': 'mudou a taxa de split de',
  'tenant.unblocked': 'reativou',
  'tenant.plan_changed': 'mudou o plano de',
  'platform.login': 'entrou na plataforma',
};

const quando = (iso: string): string =>
  new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function detalheEmTexto(evento: EventoDaPlataforma): string | null {
  const d = evento.detalhe;
  if (evento.acao === 'tenant.blocked' && typeof d['motivo'] === 'string') return d['motivo'];
  if (evento.acao === 'tenant.plan_changed') {
    const de = typeof d['de'] === 'string' ? d['de'] : 'sem plano';
    const para = typeof d['para'] === 'string' ? d['para'] : '?';
    return `${de} → ${para}`;
  }
  return null;
}

export default async function TrilhaDaPlataformaPage() {
  const token = await lerSessaoDaPlataforma();
  if (!token) redirect('/plataforma/entrar');

  const [trilha, lista] = await Promise.all([
    trilhaDaPlataforma(token, 200),
    listarBarbearias(token),
  ]);

  if (!trilha.ok) {
    if (trilha.code === 'unauthorized') redirect('/plataforma/entrar');
    return (
      <main className="ui-container painel__conteudo plataforma__trabalho">
        <h1 className="painel__titulo">Trilha</h1>
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar a trilha. Recarregue a página.
        </div>
      </main>
    );
  }

  const nomes = new Map(
    (lista.ok ? lista.dados.barbearias : []).map((b) => [b.tenantId, b.nome] as const),
  );
  const eventos = trilha.dados.eventos;

  return (
    <main className="ui-container painel__conteudo plataforma__trabalho">
      <h1 className="painel__titulo">Trilha</h1>
      <p className="painel__sub">
        Tudo que a plataforma fez, do mais recente para o mais antigo. Não é editável.
      </p>

      {eventos.length === 0 ? (
        <div className="vazio">
          <p className="vazio__titulo">Nada registrado ainda</p>
          <p className="vazio__saida">
            Bloqueios, reativações e trocas de plano aparecem aqui assim que acontecerem.
          </p>
        </div>
      ) : (
        <ol className="trilha-plataforma">
          {eventos.map((evento, indice) => {
            const detalhe = detalheEmTexto(evento);
            // A barbearia apagada não tem nome na lista, e a trilha sobrevive a
            // ela de propósito. Mostrar o id é melhor que esconder a linha.
            const alvo = evento.tenantId
              ? (nomes.get(evento.tenantId) ?? `barbearia removida (${evento.tenantId.slice(0, 8)})`)
              : null;

            return (
              <li className="evento-plataforma" key={`${evento.quando}-${indice}`}>
                <p className="evento-plataforma__linha">
                  <strong>{evento.adminNome ?? 'conta removida'}</strong>{' '}
                  {ACAO[evento.acao] ?? evento.acao}
                  {alvo ? <> <strong>{alvo}</strong></> : null}
                </p>
                {detalhe ? <p className="evento-plataforma__detalhe">{detalhe}</p> : null}
                <p className="evento-plataforma__quando">{quando(evento.quando)}</p>
              </li>
            );
          })}
        </ol>
      )}
    </main>
  );
}
