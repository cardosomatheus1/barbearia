import { redirect } from 'next/navigation';
import { estadoDoPainel, templatesDeServico } from '@/lib/admin-api';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import {
  acaoEmpresa,
  acaoPagamentos,
  acaoProfissionais,
  acaoPublicar,
  acaoSair,
  acaoServicos,
} from '../acoes';

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

const COMODIDADES = [
  { valor: 'wifi', nome: 'Wi-Fi' },
  { valor: 'parking', nome: 'Estacionamento' },
  { valor: 'accessible', nome: 'Acessível' },
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

  return (
    <main className="ui-container painel__conteudo">
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
                   placeholder="Rua Ceará, 120" />
          </div>
          <div className="painel__dupla">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="district">Bairro</label>
              <input className="ui-field__input" id="district" name="district" maxLength={80} />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="city">Cidade</label>
              <input className="ui-field__input" id="city" name="city" maxLength={80} />
            </div>
          </div>
          <div className="painel__dupla">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="state">UF</label>
              <input className="ui-field__input" id="state" name="state" maxLength={2}
                     placeholder="BA" />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="timezone">Fuso horário</label>
              <select className="ui-field__input" id="timezone" name="timezone"
                      defaultValue="America/Sao_Paulo">
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
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="instagram">Instagram</label>
            <input className="ui-field__input" id="instagram" name="instagram" maxLength={80}
                   placeholder="@domaribarber" />
          </div>
          <fieldset className="painel__grupo">
            <legend className="ui-field__label">A barbearia tem</legend>
            <div className="painel__marcas">
              {COMODIDADES.map((item) => (
                <label className="marca" key={item.valor}>
                  <input type="checkbox" name="amenities" value={item.valor} />
                  <span>{item.nome}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
            Continuar
          </button>
        </form>
      ) : null}

      {passo === 3 && templates?.ok ? (
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

      {passo === 4 ? (
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
