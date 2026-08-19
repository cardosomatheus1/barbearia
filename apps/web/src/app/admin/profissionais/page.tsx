import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  catalogoDeServicos,
  equipeDoCadastro,
  jornadaDoProfissional,
  metasDaCasa,
  type MetaDoProfissional,
  type ProfissionalDoCadastro,
  type ServicoDoCatalogo,
} from '@/lib/admin-api';
import { reais, reaisDoCampo } from '@/lib/dinheiro';
import { ESPECIALIDADES, ROTULO_DA_ESPECIALIDADE } from '@barbearia/core';
import { painelOuDesvio } from '@/lib/painel';
import {
  lerConflitoDeJornada,
  lerSenhaDeUmaVez,
  lerSessaoGestor,
  type JornadaEmConflito,
} from '@/lib/sessao-gestor';
import { DIAS, linhasDaJornada, type LinhaDoFormulario } from '@/lib/jornada';
import {
  acaoConvidar,
  acaoLigarProfissional,
  acaoMeta,
  acaoSair,
  acaoSalvarJornada,
  acaoPerfilPublico,
  acaoSalvarProfissional,
} from '../acoes';
import { secao } from '../secoes';

/**
 * Profissionais e jornadas.
 *
 * Duas coisas que o onboarding cadastrava juntas e nunca mais deixava mexer: o
 * **quem** e o **quando**. Sem esta tela, o barbeiro que passou a folgar na
 * segunda continuava aparecendo na grade da segunda, e a barbearia só descobria
 * pelo cliente que chegou e não encontrou ninguém.
 *
 * A jornada de cada pessoa é dela. O motor sempre soube disso — `work_schedules`
 * é por profissional desde o bloco 1 —, mas o onboarding gravava a mesma grade
 * para todo mundo, e não havia outra porta.
 */

export const metadata: Metadata = {
  title: 'Profissionais e jornadas',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  professional_not_found: 'Esta pessoa não está mais no cadastro.',
  invalid_catalog: 'Confira os horários da jornada.',
  forbidden: 'Sua conta não administra o cadastro da barbearia.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

/** Erros da leitura do formulário de jornada, que chegam como `code_weekday`. */
function falhaDaJornada(erro: string | undefined): string | null {
  if (!erro) return null;
  const separador = erro.lastIndexOf('_');
  const code = erro.slice(0, separador);
  const dia = DIAS.find((d) => String(d.weekday) === erro.slice(separador + 1));
  if (!dia) return FALHA[erro] ?? null;

  if (code === 'horario_invalido') return `Confira os horários de ${dia.nome.toLowerCase()}.`;
  if (code === 'fim_antes_do_inicio') {
    return `Em ${dia.nome.toLowerCase()}, a saída ficou antes da entrada.`;
  }
  if (code === 'pausa_fora') {
    return `Em ${dia.nome.toLowerCase()}, o intervalo ficou fora do horário de trabalho.`;
  }
  return null;
}

const TIPO: Record<ProfissionalDoCadastro['kind'], string> = {
  professional: 'Profissional',
  station: 'Estação',
  room: 'Sala',
};

function CamposDaPessoa({
  pessoa,
  servicos,
  prefixo,
}: {
  readonly pessoa?: ProfissionalDoCadastro;
  readonly servicos: readonly ServicoDoCatalogo[];
  readonly prefixo: string;
}) {
  // Vazio significa "faz tudo": marcar nada e marcar todos gravam a mesma coisa.
  const fazTudo = !pessoa || pessoa.serviceIds.length === servicos.length;

  return (
    <form action={acaoSalvarProfissional} className="formulario">
      {pessoa ? <input name="id" type="hidden" value={pessoa.id} /> : null}

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-name`}>
          Nome
        </label>
        <input
          className="ui-field__input"
          defaultValue={pessoa?.name ?? ''}
          id={`${prefixo}-name`}
          maxLength={80}
          minLength={2}
          name="name"
          required
        />
      </div>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-kind`}>
          O que é
        </label>
        <select
          className="ui-field__input"
          defaultValue={pessoa?.kind ?? 'professional'}
          id={`${prefixo}-kind`}
          name="kind"
        >
          <option value="professional">Profissional — entra na ocupação e na comissão</option>
          <option value="station">Estação — cadeira ou posto, sem comissão</option>
          <option value="room">Sala — espaço que se reserva, sem comissão</option>
        </select>
        <p className="ui-field__hint">
          Conta de balcão cadastrada como profissional destrói o relatório de ocupação: ela
          &ldquo;trabalha&rdquo; das 8 às 23 e nunca atende ninguém.
        </p>
      </div>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-bio`}>
          Apresentação
        </label>
        <textarea
          className="ui-field__input"
          defaultValue={pessoa?.bio ?? ''}
          id={`${prefixo}-bio`}
          maxLength={600}
          name="bio"
          rows={2}
        />
        <p className="ui-field__hint">Aparece na sua página, junto da foto.</p>
      </div>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-dailyLimit`}>
          Máximo de atendimentos por dia
        </label>
        <input
          className="ui-field__input"
          defaultValue={pessoa?.dailyLimit ?? ''}
          id={`${prefixo}-dailyLimit`}
          inputMode="numeric"
          max={100}
          min={1}
          name="dailyLimit"
          placeholder="sem limite"
          type="number"
        />
      </div>

      <label className="opcao-simples">
        <input defaultChecked={pessoa?.bookableOnline ?? true} name="bookableOnline" type="checkbox" />
        <span>
          <span className="opcao-simples__nome">Aparece na página para o cliente escolher</span>
          <span className="opcao-simples__sobre">
            Desmarque para quem só atende encaixe da recepção.
          </span>
        </span>
      </label>

      <fieldset className="painel__grupo">
        <legend className="ui-field__label">O que executa</legend>
        <p className="ui-field__hint">
          Não marcar nada significa &ldquo;faz tudo&rdquo;. Marque só quando alguém não fizer
          algum serviço — é o que tira o horário errado da grade.
        </p>
        <div className="marcas-lista">
          {servicos.map((servico) => (
            <label className="marca" key={servico.id}>
              <input
                defaultChecked={fazTudo ? false : pessoa?.serviceIds.includes(servico.id)}
                name="serviceIds"
                type="checkbox"
                value={servico.id}
              />
              <span>{servico.name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <button className="ui-button ui-button--primary ui-button--block" type="submit">
        {pessoa ? 'Salvar alterações' : 'Adicionar à equipe'}
      </button>
    </form>
  );
}

function Jornada({
  pessoa,
  linhas,
  conflito,
}: {
  readonly pessoa: ProfissionalDoCadastro;
  readonly linhas: readonly LinhaDoFormulario[];
  readonly conflito: JornadaEmConflito | null;
}) {
  return (
    <form action={acaoSalvarJornada} className="formulario">
      <input name="id" type="hidden" value={pessoa.id} />

      {conflito ? (
        <div className="ui-alert ui-alert--warning" role="alert">
          <p className="conflito__titulo">
            Esta jornada deixa{' '}
            <span className="tabular">{conflito.conflitos.length}</span>{' '}
            {conflito.conflitos.length === 1 ? 'horário' : 'horários'} de fora
          </p>
          <ul className="conflito__lista">
            {conflito.conflitos.map((fora) => (
              <li key={fora.appointmentId}>
                <span className="tabular">
                  {fora.date.slice(8, 10)}/{fora.date.slice(5, 7)} às {fora.time}
                </span>{' '}
                — {fora.customerName ?? 'cliente sem nome'}
              </li>
            ))}
          </ul>
          <p className="conflito__nota">
            Salvar não cancela nada: esses clientes continuam marcados, mas fora do horário de
            trabalho. Avise cada um ou remarque pelo <a href="/admin/dia">painel do dia</a>.
          </p>
          <input name="confirmarConflitos" type="hidden" value="1" />
        </div>
      ) : null}

      <div className="ui-scroll-x">
        <table className="jornada">
          <caption className="ui-visually-hidden">Jornada semanal de {pessoa.name}</caption>
          <thead>
            <tr>
              <th scope="col">Dia</th>
              <th scope="col">Entra</th>
              <th scope="col">Sai</th>
              <th scope="col">Intervalo</th>
            </tr>
          </thead>
          <tbody>
            {DIAS.map(({ weekday, nome }) => {
              const linha = linhas.find((l) => l.weekday === weekday);
              const campo = `${pessoa.id}-${weekday}`;
              return (
                <tr key={weekday}>
                  <th scope="row">
                    <label className="jornada__dia" htmlFor={`dia-${campo}`}>
                      <input
                        defaultChecked={linha?.trabalha ?? false}
                        id={`dia-${campo}`}
                        name={`dia_${weekday}`}
                        type="checkbox"
                      />
                      <span>{nome}</span>
                    </label>
                  </th>
                  <td>
                    <label className="ui-visually-hidden" htmlFor={`inicio-${campo}`}>
                      Entrada de {nome}
                    </label>
                    <input
                      className="ui-field__input jornada__hora"
                      defaultValue={linha?.inicio ?? '09:00'}
                      id={`inicio-${campo}`}
                      name={`inicio_${weekday}`}
                      type="time"
                    />
                  </td>
                  <td>
                    <label className="ui-visually-hidden" htmlFor={`fim-${campo}`}>
                      Saída de {nome}
                    </label>
                    <input
                      className="ui-field__input jornada__hora"
                      defaultValue={linha?.fim ?? '18:00'}
                      id={`fim-${campo}`}
                      name={`fim_${weekday}`}
                      type="time"
                    />
                  </td>
                  <td className="jornada__pausa">
                    <label className="ui-visually-hidden" htmlFor={`pausa-inicio-${campo}`}>
                      Começo do intervalo de {nome}
                    </label>
                    <input
                      className="ui-field__input jornada__hora"
                      defaultValue={linha?.pausaInicio ?? ''}
                      id={`pausa-inicio-${campo}`}
                      name={`pausa_inicio_${weekday}`}
                      type="time"
                    />
                    <label className="ui-visually-hidden" htmlFor={`pausa-fim-${campo}`}>
                      Fim do intervalo de {nome}
                    </label>
                    <input
                      className="ui-field__input jornada__hora"
                      defaultValue={linha?.pausaFim ?? ''}
                      id={`pausa-fim-${campo}`}
                      name={`pausa_fim_${weekday}`}
                      type="time"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="ui-field__hint">
        Desmarque o dia para fechá-lo. O intervalo é opcional — deixe em branco quem não para
        para almoçar.
      </p>

      <button className="ui-button ui-button--primary ui-button--block" type="submit">
        {conflito ? 'Salvar mesmo assim' : 'Salvar jornada'}
      </button>
    </form>
  );
}

/**
 * O convite para o aplicativo do barbeiro — lacuna aberta no bloco 12.
 *
 * Fica aqui, e não na tela de equipe, porque é aqui que o dono está quando
 * pensa nisso: ele acabou de cadastrar o Ruan como cadeira e a pergunta
 * seguinte é "o Ruan vê a agenda dele?". A permissão exigida continua sendo
 * `team.manage` — o caminho da tela não muda quem pode criar conta.
 *
 * Só para `professional`: agenda de estação ou sala não é pessoa, e mandar
 * senha de acesso para "Cadeira 2" cria uma conta que ninguém usa e ninguém
 * desliga. Foi o defeito D12 do sistema analisado.
 */
function Convite({
  pessoa,
  senha,
  entrega,
}: {
  readonly pessoa: ProfissionalDoCadastro;
  readonly senha?: string | undefined;
  readonly entrega?: string | undefined;
}) {
  if (pessoa.kind !== 'professional') return null;

  if (senha) {
    return (
      <div className="convite convite--pronto">
        <p className="convite__titulo">Conta criada para {pessoa.name}</p>
        <p className="convite__senha tabular">{senha}</p>
        <p className="convite__sobre">
          {entrega === 'enviada'
            ? 'A senha foi enviada por mensagem. Ela some desta tela em dois minutos — no primeiro acesso ele troca por uma dele.'
            : entrega === 'falhou'
              ? 'A mensagem não saiu: o canal estava fora do ar. Passe a senha para ele — ela some desta tela em dois minutos.'
              : 'Sem celular cadastrado, então nada foi enviado. Passe a senha para ele — ela some desta tela em dois minutos.'}
        </p>
      </div>
    );
  }

  if (pessoa.hasAccount) {
    return (
      <p className="convite__ja">
        Já tem conta. Se perdeu o acesso, reemita a senha em <a href="/admin/equipe">Usuários e acessos</a>.
      </p>
    );
  }

  return (
    <form action={acaoConvidar} className="convite">
      <input name="professionalId" type="hidden" value={pessoa.id} />

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`convite-email-${pessoa.id}`}>
          E-mail de {pessoa.name}
        </label>
        <input
          autoComplete="off"
          className="ui-field__input"
          id={`convite-email-${pessoa.id}`}
          name="email"
          placeholder="ruan@exemplo.com"
          required
          type="email"
        />
        <p className="ui-field__hint">É por ele que o barbeiro entra.</p>
      </div>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`convite-phone-${pessoa.id}`}>
          Celular
        </label>
        <input
          className="ui-field__input"
          defaultValue={pessoa.phone ?? ''}
          id={`convite-phone-${pessoa.id}`}
          inputMode="tel"
          name="phone"
          placeholder="(71) 90000-0000"
          type="tel"
        />
        <p className="ui-field__hint">
          Para onde a senha de primeiro acesso vai. Sem ele, ela só aparece nesta tela.
        </p>
      </div>

      <button className="ui-button ui-button--secondary ui-button--block" type="submit">
        Criar acesso
      </button>
    </form>
  );
}

/**
 * A meta do mês — SPEC §4.21.
 *
 * Fica na cadeira, não numa tela de relatório, porque é aqui que o dono está
 * quando pensa nisso: ele acabou de olhar quem atende e a pergunta seguinte é
 * "quanto o Ruan precisa fazer este mês?".
 *
 * O campo vem preenchido com a meta do mês anterior quando não há a deste mês —
 * **sugestão, não renovação automática.** Meta que se renova sozinha vira número
 * que ninguém escolheu e que todo mundo ignora. Campo vazio apaga, que é o único
 * jeito de dizer "sem meta".
 */
/**
 * A página pública do barbeiro (bloco 73, SPEC §5.2).
 *
 * Nasce desligada, e é a exceção consciente à regra do bloco 60 — ali, "regra
 * que beneficia nasce ligada". Aparecer numa página indexada com nome, foto,
 * nota e contagem de atendimentos é exposição pública de uma **pessoa**, e a
 * SPEC escreve "opcional, por profissional" justamente porque a decisão é de
 * quem vai aparecer.
 */
function PaginaPublica({
  pessoa,
  slug,
}: {
  readonly pessoa: ProfissionalDoCadastro;
  readonly slug: string;
}) {
  return (
    <form action={acaoPerfilPublico} className="formulario perfil-publico">
      <input name="id" type="hidden" value={pessoa.id} />

      <p className="perfil-publico__nota">
        {pessoa.perfilPublico && pessoa.perfilSlug ? (
          <>
            No ar em{' '}
            <a href={`/${slug}/b/${pessoa.perfilSlug}`}>
              /{slug}/b/{pessoa.perfilSlug}
            </a>
            . O endereço é permanente: quem salvou o link continua chegando.
          </>
        ) : (
          <>
            Fora do ar. Ligando, {pessoa.name} ganha uma página com nota, atendimentos e
            especialidades — e o cartão dele na página da barbearia passa a levar para lá.
          </>
        )}
      </p>

      <fieldset className="perfil-publico__campos">
        <legend className="ui-field__label">Especialidades (até seis)</legend>
        <div className="perfil-publico__lista">
          {ESPECIALIDADES.map((e) => (
            <label className="perfil-publico__opcao" key={e}>
              <input
                defaultChecked={pessoa.especialidades.includes(e)}
                name="especialidades"
                type="checkbox"
                value={e}
              />
              {ROTULO_DA_ESPECIALIDADE[e]}
            </label>
          ))}
        </div>
      </fieldset>

      {/**
        * Dois botões, e o `value` de cada um é o estado que ele grava.
        *
        * Com um campo escondido fixo na negação, salvar uma especialidade nova
        * numa página já publicada exigia tirá-la do ar e publicar de novo — o
        * interruptor e os campos ficavam presos no mesmo envio. O botão que
        * submete é quem manda o `ligado`, então "Salvar" preserva o estado e o
        * outro o inverte. Achado da revisão deste bloco.
        */}
      <div className="perfil-publico__botoes">
        <button
          className="ui-button ui-button--secondary perfil-publico__acao"
          name="ligado"
          type="submit"
          value={pessoa.perfilPublico ? '1' : '0'}
        >
          Salvar especialidades
        </button>
        <button
          className={`ui-button ${pessoa.perfilPublico ? 'ui-button--ghost' : 'ui-button--primary'} perfil-publico__acao`}
          name="ligado"
          type="submit"
          value={pessoa.perfilPublico ? '0' : '1'}
        >
          {pessoa.perfilPublico ? 'Tirar do ar' : 'Publicar página'}
        </button>
      </div>
    </form>
  );
}

function Meta({
  pessoa,
  meta,
  mes,
}: {
  readonly pessoa: ProfissionalDoCadastro;
  readonly meta: MetaDoProfissional | undefined;
  readonly mes: string;
}) {
  if (pessoa.kind !== 'professional') return null;

  const atual = meta?.metaCents ?? null;
  const sugestao = meta?.anteriorCents ?? null;

  return (
    <form action={acaoMeta} className="convite">
      <input name="professionalId" type="hidden" value={pessoa.id} />
      <input name="mes" type="hidden" value={mes} />

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`meta-${pessoa.id}`}>
          Meta de faturamento do mês
        </label>
        <input
          className="ui-field__input tabular"
          defaultValue={atual === null ? '' : reaisDoCampo(atual)}
          id={`meta-${pessoa.id}`}
          inputMode="decimal"
          name="metaReais"
          placeholder={sugestao === null ? '15.000,00' : reaisDoCampo(sugestao)}
          type="text"
        />
        <p className="ui-field__hint">
          {atual === null && sugestao !== null
            ? `No mês passado foi ${reais(sugestao)}. Deixe em branco para ficar sem meta.`
            : 'Deixe em branco para ficar sem meta. Ele vê o quanto falta e o ritmo, ninguém vê a dos outros.'}
        </p>
      </div>

      <button className="ui-button ui-button--secondary ui-button--block" type="submit">
        Salvar meta
      </button>
    </form>
  );
}

export default async function ProfissionaisPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;

  const [equipe, catalogo] = await Promise.all([
    equipeDoCadastro(token),
    catalogoDeServicos(token),
  ]);

  const erro = first(query['erro']);
  const salvo = first(query['salvo']) === '1';
  const orfaos = Number(first(query['orfaos']) ?? 0);
  const conflito = await lerConflitoDeJornada();
  const aberta = first(query['pessoa']) ?? conflito?.professionalId;
  /**
   * A senha vem do cookie de vida curta, nunca da URL.
   *
   * A primeira versão deste convite a mandava na query — e o `/security-review`
   * pegou. Senha em parâmetro de consulta fica no histórico e no autocompletar
   * do balcão, que é máquina compartilhada, e viaja no `Referer` de toda
   * requisição da página. O mecanismo certo já existia desde o bloco 12, na
   * tela de equipe; faltava usá-lo aqui.
   */
  const metas = await metasDaCasa(token);
  const recemCriada = await lerSenhaDeUmaVez();
  const senhaNova = recemCriada?.senha;
  const entrega = first(query['entrega']);

  if (!equipe.ok || !catalogo.ok) {
    const code = equipe.ok ? (catalogo.ok ? 'request_failed' : catalogo.code) : equipe.code;
    return (
      <main className="ui-container painel__conteudo" {...secao('profissionais')}>
        <header className="painel__topo">
          <a className="painel__marca" href="/admin/dia">
            ← {estado.businessName}
          </a>
        </header>
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[code] ?? FALHA['request_failed']} <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const pessoas = equipe.dados.professionals;
  const servicos = catalogo.dados.services.filter((servico) => servico.active);

  // A jornada só é buscada de quem está com o painel aberto: sete pessoas
  // fariam sete idas ao banco para desenhar sete tabelas que ninguém abriu.
  const emFoco = pessoas.find((pessoa) => pessoa.id === aberta);
  const jornada = emFoco ? await jornadaDoProfissional(token, emFoco.id) : null;
  const linhas = conflito?.professionalId === emFoco?.id && conflito
    ? linhasDaJornada(conflito.faixas)
    : linhasDaJornada(jornada?.ok ? jornada.dados.faixas : []);

  return (
    <main className="ui-container painel__conteudo" {...secao('profissionais')}>
      <header className="painel__topo">
        <a className="painel__marca" href="/admin/dia">
          ← {estado.businessName}
        </a>
        <form action={acaoSair}>
          <button className="ui-button ui-button--ghost painel__sair" type="submit">
            Sair
          </button>
        </form>
      </header>

      <h1 className="painel__titulo">Profissionais e jornadas</h1>
      <p className="painel__sub">
        Quem atende, o que cada um faz e em que horários. A jornada é de cada pessoa — quem folga
        na segunda some da grade da segunda, e só dela.
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {falhaDaJornada(erro) ?? FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Alteração salva.
        </div>
      ) : null}

      {orfaos > 0 ? (
        <div className="ui-alert ui-alert--warning painel__aviso" role="alert">
          <span className="tabular">{orfaos}</span>{' '}
          {orfaos === 1 ? 'cliente continua marcado' : 'clientes continuam marcados'} com quem você
          acabou de desligar. Desativar não cancela: veja no{' '}
          <a href="/admin/dia">painel do dia</a> quem remarcar.
        </div>
      ) : null}

      {pessoas.length === 0 ? (
        <div className="ui-card vazio">
          <p className="vazio__titulo">Ninguém na equipe ainda</p>
          <p className="vazio__saida">
            Sem alguém que atenda não existe grade. Comece por você mesmo, se você corta.
          </p>
        </div>
      ) : (
        <ul className="lista-cadastro">
          {pessoas.map((pessoa) => (
            <li
              className={`item-cadastro ${pessoa.active ? '' : 'item-cadastro--fora'}`}
              key={pessoa.id}
            >
              <div className="item-cadastro__cabeca">
                <div className="item-cadastro__quem">
                  <h3 className="item-cadastro__nome">
                    {pessoa.name}
                    {pessoa.active ? null : <span className="item-cadastro__selo">desligado</span>}
                    {pessoa.kind === 'professional' ? null : (
                      <span className="item-cadastro__selo">{TIPO[pessoa.kind]}</span>
                    )}
                    {pessoa.bookableOnline ? null : (
                      <span className="item-cadastro__selo">fora da página</span>
                    )}
                  </h3>
                  <p className="item-cadastro__linha">
                    {pessoa.weekdays.length === 0 ? (
                      <strong className="item-cadastro__falta">Sem jornada — não aparece na grade</strong>
                    ) : (
                      <>
                        Trabalha{' '}
                        {DIAS.filter((dia) => pessoa.weekdays.includes(dia.weekday))
                          .map((dia) => dia.curto)
                          .join(' · ')}
                      </>
                    )}
                    {' · '}
                    {pessoa.serviceIds.length >= servicos.length
                      ? 'faz tudo'
                      : `${pessoa.serviceIds.length} de ${servicos.length} serviços`}
                  </p>
                </div>

                <form action={acaoLigarProfissional}>
                  <input name="id" type="hidden" value={pessoa.id} />
                  <input name="active" type="hidden" value={pessoa.active ? '0' : '1'} />
                  <button
                    className={`ui-button ui-button--ghost item-cadastro__miuda ${
                      pessoa.active ? 'item-cadastro__risco' : ''
                    }`}
                    type="submit"
                  >
                    {pessoa.active ? 'Desligar' : 'Religar'}
                  </button>
                </form>
              </div>

              <details className="dobra">
                <summary className="dobra__titulo">Editar cadastro</summary>
                <CamposDaPessoa pessoa={pessoa} prefixo={`p-${pessoa.id}`} servicos={servicos} />
              </details>

              {pessoa.kind === 'professional' ? (
                <details className="dobra">
                  <summary className="dobra__titulo">
                    Página pública
                    {pessoa.perfilPublico ? <span className="item-cadastro__selo">no ar</span> : null}
                  </summary>
                  <PaginaPublica pessoa={pessoa} slug={estado.slug} />
                </details>
              ) : null}

              {pessoa.kind === 'professional' && metas.ok ? (
                <details className="dobra">
                  <summary className="dobra__titulo">Meta do mês</summary>
                  <Meta
                    mes={metas.dados.mes}
                    meta={metas.dados.metas.find((m) => m.professionalId === pessoa.id)}
                    pessoa={pessoa}
                  />
                </details>
              ) : null}

              {pessoa.kind === 'professional' ? (
                <details className="dobra" open={pessoa.id === aberta && Boolean(senhaNova)}>
                  <summary className="dobra__titulo">
                    Acesso ao aplicativo{pessoa.hasAccount ? ' — criado' : ''}
                  </summary>
                  <Convite
                    entrega={pessoa.id === aberta ? entrega : undefined}
                    pessoa={pessoa}
                    senha={pessoa.id === aberta ? senhaNova : undefined}
                  />
                </details>
              ) : null}

              {pessoa.id === emFoco?.id ? (
                <details className="dobra" open>
                  <summary className="dobra__titulo">Jornada da semana</summary>
                  <Jornada
                    conflito={conflito?.professionalId === pessoa.id ? conflito : null}
                    linhas={linhas}
                    pessoa={pessoa}
                  />
                </details>
              ) : (
                <p className="item-cadastro__acao">
                  <a
                    className="ui-button ui-button--secondary ui-button--block"
                    href={`/admin/profissionais?pessoa=${pessoa.id}`}
                  >
                    Ver e mudar a jornada
                  </a>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="painel__grupo">
        <h2 className="rotulo">Adicionar à equipe</h2>
        <CamposDaPessoa prefixo="novo" servicos={servicos} />
        <p className="ui-field__hint">
          Depois de criar, abra a jornada da pessoa — sem ela ninguém aparece na grade.
        </p>
      </section>

      <p className="painel__nota">
        Recepção e gerência têm conta sem cadeira, e ficam em{' '}
        <a href="/admin/equipe">Usuários e acessos</a>. Aqui é o contrário: a cadeira que ganha uma conta, para
        o barbeiro ver a agenda dele — uma cadeira, uma conta.
      </p>
    </main>
  );
}
