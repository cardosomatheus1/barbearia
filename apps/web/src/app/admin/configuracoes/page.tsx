import { redirect } from 'next/navigation';
import { painelOuDesvio } from '@/lib/painel';
import { getProfile } from '@/lib/api';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { politicasDaCasa } from '@/lib/admin-api';
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
  /**
   * As políticas preenchidas, do painel e não do perfil público.
   *
   * A tela lia `getProfile` para o prazo de cancelamento e **chutava 2** para
   * remarcação e limite de remarcações — que é o mesmo defeito do teto de
   * desconto que este bloco veio corrigir: campo que a tela não sabe ler começa
   * vazio a cada visita, e o dono acha que a configuração dele se perdeu.
   */
  const resposta = await politicasDaCasa(token);
  const politicas = resposta.ok ? resposta.dados : null;
  const query = await searchParams;
  const salvo = (Array.isArray(query['salvo']) ? query['salvo'][0] : query['salvo']) === '1';
  const erro = Array.isArray(query['erro']) ? query['erro'][0] : query['erro'];

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

      {/*
        A recusa precisa dizer o que fazer.
        "Não deu para salvar" manda o dono conferir cinco campos; o e-mail do
        encarregado é o único que o servidor recusa por formato, e é o que a
        mensagem nomeia.
      */}
      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {erro === 'invalid_request'
            ? 'Confira o e-mail do encarregado: ele precisa ter o formato nome@dominio.'
            : 'Não deu para salvar. Tente de novo.'}
        </div>
      ) : null}

      <p className="painel__nota">
        Quem pode fazer o quê fica em <a href="/admin/equipe/permissoes">Equipe · permissões</a>.
      </p>

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
                 type="number" min={0} max={720}
                 defaultValue={politicas?.rescheduleMinHours ?? 2} />
          <p className="ui-field__hint">
            Costuma ser mais folgado que o cancelamento: remarcar preserva a sua receita.
          </p>
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="maxReschedules">
            Quantas vezes o cliente pode remarcar o mesmo horário
          </label>
          <input className="ui-field__input tabular" id="maxReschedules" name="maxReschedules"
                 type="number" min={0} max={50}
                 defaultValue={politicas?.maxReschedules ?? 2} />
        </div>

        {/*
          O teto de desconto (bloco 30).

          Fica aqui e não na tela de permissões porque são perguntas diferentes:
          permissão diz **quem** pode dar desconto, o teto diz **quanto**. Sem o
          segundo, conceder o primeiro é conceder estorno com outro nome.

          Em por cento na tela e em pontos-base no banco, como toda alíquota do
          produto — a conversão fica na borda, num lugar só.
        */}
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="maxDiscountPercent">
            Desconto máximo por comanda
          </label>
          <input className="ui-field__input tabular" id="maxDiscountPercent"
                 name="maxDiscountPercent" type="number" min={0} max={100}
                 defaultValue={Math.round((politicas?.maxDiscountBps ?? 2000) / 100)} />
          <p className="ui-field__hint">
            Em por cento do subtotal. Quem dá desconto precisa da permissão
            &ldquo;dar desconto&rdquo;; este número é o limite dela. Zero desliga o desconto.
          </p>
        </div>

        {/*
          O encarregado de dados (bloco 31).

          A LGPD art. 41 §1 manda **divulgar publicamente** quem é e como
          falar com ele. Por isso os dois campos saem daqui direto para a
          página pública: encarregado cadastrado e não publicado é o mesmo
          que não ter — o titular continua sem saber para quem escrever.
        */}
        <fieldset className="painel__grupo">
          <legend className="ui-field__label">Encarregado de dados (LGPD)</legend>
          <p className="ui-field__hint">
            Quem responde quando um cliente pedir os dados dele. Costuma ser o dono. O nome e o
            contato aparecem na sua página, porque a lei manda divulgá-los.
          </p>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="dpoName">Nome</label>
            <input className="ui-field__input" defaultValue={politicas?.dpoName ?? ''}
                   id="dpoName" maxLength={120} name="dpoName" type="text"
                   placeholder="Marcos Andrade" />
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="dpoEmail">E-mail</label>
            <input className="ui-field__input" defaultValue={politicas?.dpoEmail ?? ''}
                   id="dpoEmail" maxLength={160} name="dpoEmail" type="email"
                   placeholder="contato@suabarbearia.com.br" />
          </div>

          <p className="painel__nota">
            Os pedidos que chegarem ficam em <a href="/admin/lgpd">Pedidos de dados</a>.
          </p>
        </fieldset>

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
