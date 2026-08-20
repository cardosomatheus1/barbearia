import { redirect } from 'next/navigation';
import { estadoDoPainel, templatesDeServico } from '@/lib/admin-api';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { COMODIDADES, ROTULO_DA_COMODIDADE } from '@barbearia/core';
import {
  acaoEmpresa,
  acaoPagamentos,
  acaoProfissionais,
  acaoPublicar,
  acaoSair,
  acaoServicos,
} from '../acoes';
import { secao } from '../secoes';

/**
 * Onboarding em seis etapas.
 *
 * Cada etapa é uma URL e grava sozinha (SPEC Parte 1 §1.5): abandonar no passo 4
 * não perde os passos 1 a 3. O passo mostrado vem do `?e=`, e o passo **salvo**
 * vem do servidor — quem volta amanhã do celular cai onde parou.
 */

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

const FALHA: Record<string, string> = {
  invalid_catalog:
    'Um combo está prometendo menos tempo do que as partes levam. Ajuste a duração — é isso que faz o barbeiro atrasar o dia inteiro.',
  nenhum_servico: 'Escolha pelo menos um serviço.',
  nenhum_profissional: 'Cadastre pelo menos um profissional.',
  nenhum_dia: 'Marque os dias em que a barbearia abre.',
  jornada_invertida: 'O horário de abrir precisa ser antes do de fechar.',
  nothing_to_publish: 'Falta serviço, equipe ou jornada para publicar.',
  invalid_request: 'Confira os dados e tente de novo.',
};

const DIAS = [
  { valor: 1, nome: 'Seg' },
  { valor: 2, nome: 'Ter' },
  { valor: 3, nome: 'Qua' },
  { valor: 4, nome: 'Qui' },
  { valor: 5, nome: 'Sex' },
  { valor: 6, nome: 'Sáb' },
  { valor: 0, nome: 'Dom' },
];

const PAGAMENTOS = [
  { valor: 'pix', nome: 'Pix' },
  { valor: 'card', nome: 'Cartão' },
  { valor: 'cash', nome: 'Dinheiro' },
  { valor: 'online', nome: 'Pagamento online' },
];

const money = (cents: number): string => (cents / 100).toFixed(2);

export default async function OnboardingPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await estadoDoPainel(token);
  // Sessão morta devolve erro, não estado vazio: mandar para o login é o único
  // caminho honesto.
  if (!estado.ok) redirect('/admin/entrar');

  const query = await searchParams;
  const erro = first(query['erro']);
  const quais = (first(query['quais']) ?? '').split(',').filter(Boolean);
  const publicado = first(query['publicado']) === '1';

  // O passo pedido na URL, limitado ao que já foi concluído mais um: pular para
  // "publicar" sem cadastrar nada só produziria uma recusa sem explicação.
  const pedido = Number(first(query['e']) ?? 0);
  const maximo = Math.min(estado.dados.step + 1, 6);
  const passo = pedido >= 2 && pedido <= maximo ? pedido : Math.min(Math.max(estado.dados.step, 2), 6);

  const templates = passo === 3 ? await templatesDeServico(token) : null;

  /**
   * O cadastro que já existe, para a etapa 2 **vir preenchida** (bloco 111).
   *
   * Ela nasceu formulário de cadastro e continuou formulário de cadastro: só o
   * nome vinha preenchido, e o fuso vinha fixo em São Paulo. Voltar para
   * corrigir o telefone mandava tudo o mais em branco — e do outro lado o
   * domínio gravava branco. Agora o domínio preserva o ausente, e a tela mostra
   * o que a pessoa está prestes a mudar, que é o que uma tela de edição faz.
   */
  const empresa = estado.dados.empresa;

  /**
   * Depois de a casa abrir, as etapas 3 e 4 não desenham formulário.
   *
   * Elas **substituem** o catálogo e a equipe inteiros — certo para quem está
   * montando, destruição a partir do dia seguinte. O domínio passou a recusar
   * (`ja_publicada`), e recusar sozinho não bastava: a tela continuava
   * oferecendo o botão, e o que a pessoa recebia era um erro depois de escolher
   * oito serviços. Oferecer e recusar é pior que não oferecer.
   *
   * A etapa 2 continua aberta de propósito: ela é a **única** tela desse
   * cadastro, e é para onde quem quer corrigir o endereço precisa chegar.
   */
  const noAr = estado.dados.publishedAt !== null;
  const substitui = noAr && (passo === 3 || passo === 4);

  return (
    <main className="ui-container painel__conteudo" {...secao('onboarding')}>
      <header className="painel__topo">
        <p className="painel__marca">{estado.dados.businessName}</p>
        <form action={acaoSair}>
          <button className="ui-button ui-button--ghost painel__sair" type="submit">Sair</button>
        </form>
      </header>

      <ol className="passos" aria-label="Etapas do cadastro">
        {['Conta', 'Empresa', 'Serviços', 'Equipe', 'Pagamento', 'Publicar'].map((nome, i) => {
          const numero = i + 1;
          const concluida = numero <= estado.dados.step;
          return (
            <li
              key={nome}
              className={`passo ${numero === passo ? 'passo--atual' : ''} ${concluida ? 'passo--feito' : ''}`}
              aria-current={numero === passo ? 'step' : undefined}
            >
              <span className="passo__numero tabular">{concluida && numero !== passo ? '✓' : numero}</span>
              <span className="passo__nome">{nome}</span>
            </li>
          );
        })}
      </ol>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? 'Não foi possível salvar. Tente de novo.'}
          {quais.length > 0 ? <> Confira: {quais.join(', ')}.</> : null}
        </div>
      ) : null}

      {passo === 2 ? (
        <form action={acaoEmpresa} className="formulario" aria-labelledby="t">
          <h1 className="painel__titulo" id="t">Onde fica a barbearia</h1>
          <p className="painel__sub">
            Metade de quem abre a página quer saber isto — e o concorrente analisado não responde
            (defeitos D8 e D9).
          </p>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="name">Nome</label>
            <input className="ui-field__input" id="name" name="name" required
                   defaultValue={estado.dados.businessName} maxLength={80} />
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="street">Endereço</label>
            <input className="ui-field__input" id="street" name="street" maxLength={160}
                   defaultValue={empresa.street ?? ''} placeholder="Rua Ceará, 120" />
          </div>
          <div className="painel__dupla">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="district">Bairro</label>
              <input className="ui-field__input" id="district" name="district" maxLength={80}
                     defaultValue={empresa.district ?? ''} />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="city">Cidade</label>
              <input className="ui-field__input" id="city" name="city" maxLength={80}
                     defaultValue={empresa.city ?? ''} />
            </div>
          </div>
          <div className="painel__dupla">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="state">UF</label>
              <input className="ui-field__input" id="state" name="state" maxLength={2}
                     defaultValue={empresa.state ?? ''} placeholder="BA" />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="timezone">Fuso horário</label>
              <select className="ui-field__input" id="timezone" name="timezone"
                      defaultValue={empresa.timezone}>
                <option value="America/Sao_Paulo">Brasília (SP, RJ, MG…)</option>
                <option value="America/Bahia">Bahia</option>
                <option value="America/Fortaleza">Ceará, PI, RN, PB, PE, AL, SE</option>
                <option value="America/Recife">Recife</option>
                <option value="America/Belem">Pará, Amapá</option>
                <option value="America/Manaus">Amazonas, Rondônia, Roraima</option>
                <option value="America/Cuiaba">Mato Grosso</option>
                <option value="America/Campo_Grande">Mato Grosso do Sul</option>
                <option value="America/Rio_Branco">Acre</option>
              </select>
              <p className="ui-field__hint">
                A grade de horários sai deste fuso, nunca do celular do cliente.
              </p>
            </div>
          </div>
          {/**
            * Telefone e WhatsApp, que faltavam desde o bloco 4.
            *
            * A página pública desenha um botão de ligar desde então, e o número
            * saía sempre nulo: `locations.phone_e164` existia, a API aceitava o
            * campo e **nenhuma tela o preenchia**. Botão de ligar sem número é
            * pior que botão nenhum — o cliente aperta e não acontece nada.
            *
            * Fixo é aceito aqui e recusado no cadastro do cliente, e é de
            * propósito: o do cliente recebe o código de acesso.
            */}
          <div className="campos-lado">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="phone">
                Telefone <span className="ui-field__hint">(opcional)</span>
              </label>
              <input className="ui-field__input" id="phone" inputMode="tel" maxLength={24}
                     defaultValue={empresa.phone ?? ''}
                     name="phone" placeholder="(71) 3333-4444" type="tel" />
              <p className="ui-field__hint">Aparece na página como botão de ligar. Fixo serve.</p>
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="whatsapp">
                WhatsApp <span className="ui-field__hint">(opcional)</span>
              </label>
              <input className="ui-field__input" id="whatsapp" inputMode="tel" maxLength={24}
                     defaultValue={empresa.whatsapp ?? ''}
                     name="whatsapp" placeholder="(71) 99999-0000" type="tel" />
            </div>
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="instagram">Instagram</label>
            <input className="ui-field__input" id="instagram" name="instagram" maxLength={80}
                   defaultValue={empresa.instagram ?? ''} placeholder="@domaribarber" />
          </div>
          {/*
            O texto que a página pública mostra, e que não tinha por onde ser
            escrito. `locations.about` existia, o perfil público o desenha e
            **nenhuma tela o preenchia** — é o defeito de `blocks` de novo, e o
            de `phone_e164` que este mesmo formulário já pagou uma vez.
          */}
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="about">Sobre a barbearia</label>
            <textarea className="ui-field__input" id="about" name="about" maxLength={600} rows={3}
                      defaultValue={empresa.about ?? ''}
                      placeholder="Barbearia de bairro na Pituba desde 2016. Corte clássico, navalha e barba." />
            <p className="ui-field__hint">Aparece na sua página, abaixo do nome.</p>
          </div>

          <fieldset className="painel__grupo">
            <legend className="ui-field__label">A barbearia tem</legend>
            <div className="painel__marcas">
              {COMODIDADES.map((valor) => (
                <label className="marca" key={valor}>
                  {/*
                    Marcada é obrigatório aqui, e não enfeite: `amenities` é o
                    único campo que o domínio grava de forma absoluta — a tela
                    manda a lista inteira das caixas, e desmarcar todas é uma
                    decisão. Sem o `defaultChecked`, abrir a tela já era
                    desmarcar tudo, e "Continuar" apagava as cinco comodidades
                    que a página pública mostra.
                  */}
                  <input type="checkbox" name="amenities" value={valor}
                         defaultChecked={empresa.amenities.includes(valor)} />
                  <span>{ROTULO_DA_COMODIDADE[valor]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
            Continuar
          </button>
        </form>
      ) : null}

      {substitui ? (
        <section aria-labelledby="t">
          <h1 className="painel__titulo" id="t">
            {passo === 3 ? 'Seus serviços' : 'Sua equipe'}
          </h1>
          <div className="ui-alert ui-alert--warning painel__aviso" role="status">
            Esta etapa monta o cadastro do primeiro dia — ela substitui{' '}
            {passo === 3 ? 'o cardápio inteiro' : 'a equipe inteira'}, e sua barbearia já está no
            ar. O que já foi vendido aponta para o cadastro atual.
          </div>
          <p className="painel__sub">
            {passo === 3
              ? 'Para mudar preço, duração ou acrescentar um serviço, use o Catálogo — lá a edição é por item e não desfaz nada.'
              : 'Para acrescentar, editar ou desligar uma cadeira, use Profissionais — lá a edição é por pessoa e a agenda dela continua de pé.'}
          </p>
          <div className="painel__acoes">
            <a
              className="ui-button ui-button--primary"
              href={passo === 3 ? '/admin/catalogo' : '/admin/profissionais'}
            >
              {passo === 3 ? 'Abrir o Catálogo' : 'Abrir Profissionais'}
            </a>
            <a className="ui-button ui-button--secondary" href="/admin/onboarding">
              Voltar
            </a>
          </div>
        </section>
      ) : null}

      {!substitui && passo === 3 && templates?.ok ? (
        <form action={acaoServicos} className="formulario" aria-labelledby="t">
          <h1 className="painel__titulo" id="t">O que você faz</h1>
          <p className="painel__sub">
            Já vem com duração e limpeza coerentes. Ajuste o preço — a duração é o que quebra a
            agenda quando está errada.
          </p>

          <ul className="cardapio">
            {templates.dados.templates.map((t) => (
              <li className={`cardapio__item ${quais.includes(t.key) ? 'cardapio__item--erro' : ''}`} key={t.key}>
                <input type="hidden" name="chave" value={t.key} />
                <input type="hidden" name={`nome_${t.key}`} value={t.name} />
                <input type="hidden" name={`descricao_${t.key}`} value={t.description} />
                <input type="hidden" name={`categoria_${t.key}`} value={t.category} />
                <input type="hidden" name={`buffer_${t.key}`} value={t.bufferAfterMinutes} />
                <input type="hidden" name={`componentes_${t.key}`} value={(t.componentKeys ?? []).join(',')} />

                <label className="cardapio__escolha">
                  <input type="checkbox" name="escolhidos" value={t.key} defaultChecked />
                  <span className="cardapio__nome">{t.name}</span>
                </label>

                <div className="cardapio__campos">
                  <label className="cardapio__campo">
                    <span>Minutos</span>
                    <input className="ui-field__input tabular" type="number" min={5} max={600} step={5}
                           name={`duracao_${t.key}`} defaultValue={t.durationMinutes} />
                  </label>
                  <label className="cardapio__campo">
                    <span>Preço R$</span>
                    <input className="ui-field__input tabular" type="number" min={0} step="0.01"
                           name={`preco_${t.key}`} defaultValue={money(t.priceCents)} />
                  </label>
                </div>
              </li>
            ))}
          </ul>

          <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
            Continuar
          </button>
        </form>
      ) : null}

      {!substitui && passo === 4 ? (
        <form action={acaoProfissionais} className="formulario" aria-labelledby="t">
          <h1 className="painel__titulo" id="t">Quem atende</h1>
          <p className="painel__sub">
            Só barbeiro de verdade. Conta de balcão entra depois, na agenda — misturar as duas
            destrói o relatório de ocupação (defeito D12).
          </p>

          {[0, 1, 2, 3].map((i) => (
            <div className="ui-field" key={i}>
              <label className="ui-field__label" htmlFor={`prof${i}`}>
                {i === 0 ? 'Profissional' : `Profissional ${i + 1} (opcional)`}
              </label>
              <input className="ui-field__input" id={`prof${i}`} name="profissional"
                     maxLength={80} {...(i === 0 ? { required: true } : {})} />
            </div>
          ))}

          <fieldset className="painel__grupo">
            <legend className="ui-field__label">Dias em que abre</legend>
            <div className="painel__marcas">
              {DIAS.map((dia) => (
                <label className="marca" key={dia.valor}>
                  <input type="checkbox" name="dia" value={dia.valor}
                         defaultChecked={dia.valor >= 2 || dia.valor === 0 ? dia.valor !== 0 : false} />
                  <span>{dia.nome}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="painel__dupla">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="abre">Abre</label>
              <select className="ui-field__input" id="abre" name="abre" defaultValue="540">
                {[420, 480, 540, 600].map((m) => (
                  <option key={m} value={m}>{`${String(Math.floor(m / 60)).padStart(2, '0')}:00`}</option>
                ))}
              </select>
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="fecha">Fecha</label>
              <select className="ui-field__input" id="fecha" name="fecha" defaultValue="1080">
                {[1020, 1080, 1140, 1200, 1260].map((m) => (
                  <option key={m} value={m}>{`${String(Math.floor(m / 60)).padStart(2, '0')}:00`}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="ui-field__hint">
            A mesma jornada para toda a equipe. O ajuste por pessoa fica na agenda.
          </p>

          <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
            Continuar
          </button>
        </form>
      ) : null}

      {passo === 5 ? (
        <form action={acaoPagamentos} className="formulario" aria-labelledby="t">
          <h1 className="painel__titulo" id="t">Como o cliente paga</h1>
          <p className="painel__sub">Aparece na página, para ninguém chegar sem saber.</p>

          <div className="painel__marcas">
            {PAGAMENTOS.map((item) => (
              <label className="marca" key={item.valor}>
                <input type="checkbox" name="metodo" value={item.valor}
                       defaultChecked={item.valor !== 'online'} />
                <span>{item.nome}</span>
              </label>
            ))}
          </div>

          <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
            Continuar
          </button>
        </form>
      ) : null}

      {passo === 6 ? (
        <section aria-labelledby="t">
          <h1 className="painel__titulo" id="t">
            {publicado ? 'Sua barbearia está no ar' : 'Pronto para publicar'}
          </h1>

          <div className="ui-card publicar">
            <p className="publicar__rotulo">Seu link</p>
            <p className="publicar__link">/{estado.dados.slug}</p>
            <p className="publicar__nota">
              Este endereço é permanente. Se você trocar o nome da barbearia, ele continua
              funcionando — o link na bio do Instagram não pode quebrar.
            </p>
          </div>

          <dl className="confere painel__resumo">
            <div><dt>Serviços</dt><dd className="tabular">{estado.dados.counts.services}</dd></div>
            <div><dt>Equipe</dt><dd className="tabular">{estado.dados.counts.professionals}</dd></div>
            <div><dt>Jornadas</dt><dd className="tabular">{estado.dados.counts.schedules}</dd></div>
          </dl>

          {publicado || estado.dados.publishedAt ? (
            <div className="painel__acoes">
              <a className="ui-button ui-button--primary" href={`/${estado.dados.slug}`}>
                Ver minha página
              </a>
              <a className="ui-button ui-button--secondary" href="/admin/configuracoes">
                Ajustar cancelamento
              </a>
              <a className="ui-button ui-button--secondary" href="/admin/avisos">
                Avisos ao cliente
              </a>
            </div>
          ) : (
            <form action={acaoPublicar}>
              <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
                Publicar minha página
              </button>
            </form>
          )}
        </section>
      ) : null}
    </main>
  );
}
