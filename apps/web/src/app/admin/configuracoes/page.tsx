import { redirect } from 'next/navigation';
import { painelOuDesvio } from '@/lib/painel';
import { getProfile } from '@/lib/api';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoJanela, acaoSair } from '../acoes';
import { secao } from '../secoes';

/**
 * Janela de cancelamento e remarcação.
 *
 * Era lacuna declarada do bloco 9: as colunas existiam, a API já as aplicava, e
 * mudá-las exigia SQL. Aqui a barbearia decide — e o número escolhido é o mesmo
 * que aparece escrito na página do cliente.
 */

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ConfiguracoesPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);

  const perfil = await getProfile(estado.slug);
  const query = await searchParams;
  const salvo = (Array.isArray(query['salvo']) ? query['salvo'][0] : query['salvo']) === '1';

  return (
    <main className="ui-container painel__conteudo" {...secao('configuracoes')}>
      <header className="painel__topo">
        <a className="painel__marca" href="/admin/onboarding">← {estado.businessName}</a>
        <form action={acaoSair}>
          <button className="ui-button ui-button--ghost painel__sair" type="submit">Sair</button>
        </form>
      </header>

      <h1 className="painel__titulo">Cancelamento e remarcação</h1>
      <p className="painel__sub">
        O prazo que você escolher é o que a página do cliente escreve — e o que a API aplica.
      </p>

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Configuração salva.
        </div>
      ) : null}

      <form action={acaoJanela} className="formulario">
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="cancelMinHours">
            Cancelar com quantas horas de antecedência
          </label>
          <input className="ui-field__input tabular" id="cancelMinHours" name="cancelMinHours"
                 type="number" min={0} max={720}
                 defaultValue={perfil?.location.cancelMinHours ?? 2} />
          <p className="ui-field__hint">Zero libera o cancelamento até a hora do atendimento.</p>
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="rescheduleMinHours">
            Remarcar com quantas horas de antecedência
          </label>
          <input className="ui-field__input tabular" id="rescheduleMinHours" name="rescheduleMinHours"
                 type="number" min={0} max={720} defaultValue={2} />
          <p className="ui-field__hint">
            Costuma ser mais folgado que o cancelamento: remarcar preserva a sua receita.
          </p>
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="maxReschedules">
            Quantas vezes o cliente pode remarcar o mesmo horário
          </label>
          <input className="ui-field__input tabular" id="maxReschedules" name="maxReschedules"
                 type="number" min={0} max={50} defaultValue={2} />
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="cancellationPolicy">
            Observação (opcional)
          </label>
          <textarea className="ui-field__input" id="cancellationPolicy" name="cancellationPolicy"
                    maxLength={300} rows={3}
                    defaultValue={perfil?.location.cancellationPolicy ?? ''} />
          <p className="ui-field__hint">
            Entra depois do prazo. O prazo em si vem do número acima, não daqui.
          </p>
        </div>

        <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
          Salvar
        </button>
      </form>
    </main>
  );
}
