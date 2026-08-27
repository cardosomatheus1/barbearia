import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { CABECALHOS_ACEITOS } from '@barbearia/core';
import {
  lerImportacao,
  listarImportacoes,
  listarSlugs,
  type LinhaComProblema,
  type ResumoDaImportacao,
  type SlugDaCasa,
} from '@/lib/admin-api';
import { exigirRecurso, painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import {
  acaoAdicionarSlug,
  acaoAnalisarImportacao,
  acaoAplicarImportacao,
  acaoReverterImportacao,
  acaoSair,
} from '../acoes';
import { secao } from '../secoes';
import { marcaDaRecusa } from '../falha-da-leitura';
import { ResolverConflitos } from './resolver-conflitos';
import { mascararTelefone } from './conflitos';

/**
 * Trazer a base do sistema antigo — SPEC §5.8.
 *
 * > "Sem importador, a venda morre na objeção 'vou perder meus clientes'."
 *
 * A tela tem uma ordem que não é a do desenvolvedor, é a de quem está migrando:
 * **enviar → conferir → aplicar**, e o "conferir" é o passo que existe para
 * poder desistir. Um importador que aplica direto é mais fácil de escrever e é
 * o que faz a barbearia descobrir mil clientes com o nome trocado depois.
 *
 * O que a tela mostra do preview é o que **pede decisão**: telefone que não
 * existe, linha sem nome, e o mesmo celular com dois nomes. O que vai entrar
 * limpo é contagem — mil e duzentas linhas na tela não ajudam ninguém a decidir
 * se aplica.
 */

export const metadata: Metadata = {
  title: 'Trazer minha base',
  robots: { index: false, follow: false },
};

/**
 * O nome de cada campo na tela. Só o rótulo: a lista de aliases vem do
 * catálogo, e é ela que não pode ficar velha.
 */
const NOME_DO_CAMPO: Readonly<Record<'nome' | 'telefone' | 'nascimento' | 'observacao', string>> = {
  nome: 'Nome',
  telefone: 'Celular',
  nascimento: 'Aniversário',
  observacao: 'Observações',
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const ERRO: Record<string, string> = {
  sem_arquivo: 'Escolha o arquivo antes de enviar.',
  arquivo_grande: 'O arquivo passa de 8 MB. Exporte em partes.',
  csv_invalido: 'Não deu para ler o arquivo. Ele precisa ser CSV, exportado da sua agenda antiga.',
  arquivo_vazio: 'O arquivo só tem o cabeçalho — nenhuma linha de cliente.',
  sem_coluna_de_telefone:
    'Não achei a coluna de telefone. Ela precisa se chamar Celular, Telefone ou WhatsApp.',
  sem_coluna_de_nome: 'Não achei a coluna de nome. Ela precisa se chamar Nome ou Cliente.',
  ja_aplicada: 'Esta importação já foi aplicada.',
  nao_aplicada: 'Esta importação ainda não foi aplicada.',
  tem_movimento:
    'Não dá para desfazer: alguém que entrou por esta importação já marcou horário, abriu comanda ou entrou na fila.',
  conflito_invalido: 'Escolha um dos dois cadastros antes de confirmar.',
  conflito_nao_encontrado: 'Este conflito já foi resolvido ou o preview venceu. Recarregue a página.',
  nao_encontrada: 'Essa importação não existe mais.',
  ja_usado: 'Esse endereço já é de outra barbearia. Escolha outro.',
  ja_e_seu: 'Esse endereço já leva para cá.',
  reservado: 'Esse endereço é usado pelo sistema. Escolha outro.',
  formato_invalido: 'Use só letras minúsculas, números e hífen — como barbearia-do-ze.',
};

const MOTIVO_DO_TELEFONE: Record<string, string> = {
  empty: 'em branco',
  too_short: 'curto demais',
  too_long: 'longo demais',
  invalid_characters: 'tem caractere que não é número',
  invalid_country: 'código de país estranho',
  invalid_br_area_code: 'DDD que não existe',
  invalid_br_subscriber: 'não parece celular',
};

/**
 * Fuso da unidade, e não do processo (bloco 135).
 *
 * Sem `timeZone`, `Intl` usa UTC no servidor e o do aparelho no navegador: o
 * React não reidrata a hora e a **página inteira** cai com o erro 418. É o
 * defeito D2 com uma segunda consequência, e foi assim que a ficha do cliente
 * quebrou no percurso da medição do bloco 134.
 */
const quando = (fuso: string, iso: string): string =>
  new Intl.DateTimeFormat('pt-BR', {
    timeZone: fuso,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

/** A frase da SPEC: "1.240 clientes, 38 duplicados, 12 telefones inválidos". */
function frase(resumo: ResumoDaImportacao['resumo']): string {
  const partes = [`${resumo.novo} ${resumo.novo === 1 ? 'cliente novo' : 'clientes novos'}`];
  if (resumo.ja_existe > 0) partes.push(`${resumo.ja_existe} já na base`);

  const duplicados = resumo.repetido_no_arquivo + resumo.conflito;
  if (duplicados > 0) partes.push(`${duplicados} ${duplicados === 1 ? 'duplicado' : 'duplicados'}`);

  const invalidos = resumo.telefone_invalido + resumo.sem_nome;
  if (invalidos > 0) {
    partes.push(`${invalidos} ${invalidos === 1 ? 'linha inválida' : 'linhas inválidas'}`);
  }

  return partes.join(', ');
}

function Problema({ linha }: { readonly linha: LinhaComProblema }) {
  const explicacao =
    linha.veredito === 'telefone_invalido'
      ? `telefone ${MOTIVO_DO_TELEFONE[linha.motivo ?? ''] ?? 'inválido'}`
      : linha.veredito === 'sem_nome'
        ? 'sem nome'
        : `mesmo celular de ${linha.conflitaCom}`;

  return (
    <li className="defeito defeito--publicacao">
      <p className="defeito__selo">Linha {linha.linha}</p>
      <p className="defeito__titulo">{linha.nome || linha.telefone}</p>
      <p className="defeito__conserto">
        {explicacao}. Corrija no arquivo e envie de novo, ou siga sem esta linha.
      </p>
    </li>
  );
}

function Importacao({
  item,
  fuso,
}: {
  readonly item: ResumoDaImportacao;
  /** O fuso da unidade. Sem ele a hora diverge entre servidor e navegador (bloco 135). */
  readonly fuso: string;
}) {
  const rotulo =
    item.status === 'applied' ? 'aplicada' : item.status === 'reverted' ? 'desfeita' : 'só conferida';

  return (
    <li className="evento">
      <p className="evento__quando tabular">
        <time dateTime={item.createdAt}>{quando(fuso, item.createdAt)}</time>
      </p>
      <p className="evento__frase">
        <strong>{item.fileName}</strong> — {rotulo}, {frase(item.resumo)}
      </p>
      {item.status === 'applied' ? (
        <form action={acaoReverterImportacao}>
          <input name="id" type="hidden" value={item.id} />
          <button className="ui-button ui-button--secondary" type="submit">
            Desfazer esta importação
          </button>
        </form>
      ) : null}
    </li>
  );
}

function Enderecos({ slugs }: { readonly slugs: readonly SlugDaCasa[] }) {
  return (
    <section className="importar__bloco">
      <h2 className="avisos__titulo">Endereços que levam até você</h2>
      <p className="painel__nota">
        O link do sistema antigo está na sua bio e no cartão impresso. Cadastre-o aqui e ele
        continua funcionando depois da mudança.
      </p>

      <ul className="eventos">
        {slugs.map((endereco) => (
          <li className="evento" key={endereco.slug}>
            <p className="evento__frase">
              /{endereco.slug}
              {endereco.principal ? <span className="evento__quando"> principal</span> : null}
            </p>
          </li>
        ))}
      </ul>

      <form action={acaoAdicionarSlug} className="importar__form">
        <label className="ui-field">
          <span className="ui-field__label">Endereço antigo</span>
          <input
            className="ui-field__input"
            inputMode="url"
            maxLength={60}
            name="slug"
            placeholder="barbearia-do-ze"
            required
          />
        </label>
        <button className="ui-button ui-button--secondary" type="submit">
          Adicionar endereço
        </button>
      </form>
    </section>
  );
}

export default async function ImportarPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  exigirRecurso(estado, 'importacao');
  const podeImportar = podeNaTela(estado, 'customers.edit');
  const podeEndereco = podeNaTela(estado, 'settings.manage');

  const query = await searchParams;
  const erro = first(query['erro']);
  const feito = first(query['feito']);
  const desfeito = first(query['desfeito']);
  const escolhida = first(query['i']);

  const [lista, enderecos, conferir] = await Promise.all([
    podeImportar ? listarImportacoes(token) : Promise.resolve(null),
    podeEndereco ? listarSlugs(token) : Promise.resolve(null),
    escolhida && podeImportar ? lerImportacao(token, escolhida) : Promise.resolve(null),
  ]);

  const importacoes = lista?.ok ? lista.dados.imports : [];
  // Só o que ainda está em preview vira o passo 2. Uma importação já aplicada
  // aberta pelo mesmo endereço mostra o histórico, não um botão de aplicar.
  const emPreview = conferir?.ok && conferir.dados.status === 'previewed' ? conferir.dados : null;

  return (
    <main className="ui-container painel__conteudo" {...secao('importar')}>
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
      {/* A recepcionista importa a base (`customers.edit`) e não mexe no
          cadastro da casa (`settings.manage`). Mostrar-lhe as outras abas seria
          oferecer quatro links que respondem 403 — botão que só serve para dar
          erro é pior que botão ausente. */}

      <h1 className="painel__titulo">Importar dados</h1>

      {!podeImportar ? (
        <div className="ui-alert ui-alert--warning" role="alert" {...marcaDaRecusa('forbidden')}>
          Sua conta não mexe na base de clientes da barbearia.
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">
            Voltar ao dia
          </a>
        </div>
      ) : null}

      {podeImportar ? (
        <p className="painel__sub">
          Exporte os clientes da sua agenda atual em CSV e envie aqui. Nada é gravado antes de você
          conferir — e o que for aplicado pode ser desfeito.
        </p>
      ) : null}

      {erro ? (
        <div className="ui-alert ui-alert--danger" role="alert">
          {ERRO[erro] ?? 'Não deu para concluir. Tente de novo.'}
        </div>
      ) : null}

      {feito ? (
        <div className="ui-alert ui-alert--success" role="status">
          Pronto: {feito} {Number(feito) === 1 ? 'cliente entrou' : 'clientes entraram'} na sua base.
          {Number(query['atualizados'] ?? 0) > 0
            ? ` ${query['atualizados']} já existiam e foram completados.`
            : ''}
        </div>
      ) : null}

      {desfeito ? (
        <div className="ui-alert ui-alert--success" role="status">
          Importação desfeita: {desfeito}{' '}
          {Number(desfeito) === 1 ? 'cliente saiu' : 'clientes saíram'} da base.
        </div>
      ) : null}

      {query['slug'] ? (
        <div className="ui-alert ui-alert--success" role="status">
          Endereço cadastrado. O link antigo já leva para a sua página.
        </div>
      ) : null}

      {query['conflito'] ? (
        <div className="ui-alert ui-alert--success" role="status">
          Escolha salva. Este celular já tem um cadastro definido para a importação.
        </div>
      ) : null}

      {/* Passo 1 — o arquivo. */}
      {podeImportar ? (
      <section className="importar__bloco">
        <h2 className="avisos__titulo">1. Envie o arquivo</h2>
        <form action={acaoAnalisarImportacao} className="importar__form">
          <label className="ui-field">
            <span className="ui-field__label">Arquivo CSV</span>
            <input
              accept=".csv,text/csv,text/plain"
              className="ui-field__input"
              name="arquivo"
              required
              type="file"
            />
            <span className="ui-field__hint">
              Precisa ter uma coluna de nome e uma de celular. Aniversário e observações entram
              junto se existirem.
            </span>
          </label>
          <button className="ui-button ui-button--primary" type="submit">
            Conferir arquivo
          </button>
        </form>

        {/*
          Os cabeçalhos aceitos, **derivados do parser**.

          A tela dizia só "uma coluna de nome e uma de celular", e quem exporta
          de outro sistema ficava adivinhando se `WhatsApp` ou `Nome do Cliente`
          serviam — quando os dois servem, e mais uma dúzia. Escrever a lista
          aqui à mão a deixaria para trás no primeiro alias novo: é o defeito
          das listas paralelas que este repositório já pagou cinco vezes.
        */}
        <details className="dobra importar__cabecalhos">
          {/* `dobra__titulo` porque `<summary>` sem classe sai com 24px, abaixo
              dos 44 — e não é link dentro de frase. */}
          <summary className="dobra__titulo">Como o cabeçalho precisa se chamar</summary>
          <p className="cartao-balcao__texto">
            Não precisa renomear nada se a sua planilha já usa um destes — a comparação ignora
            acento, maiúscula e pontuação, e entende cabeçalho composto como{' '}
            <em>Telefone (WhatsApp)</em>.
          </p>
          <dl className="significados">
            {(Object.keys(CABECALHOS_ACEITOS) as (keyof typeof CABECALHOS_ACEITOS)[]).map((campo) => (
              <div className="significados__par" key={campo}>
                <dt>
                  {NOME_DO_CAMPO[campo]}
                  {campo === 'nome' || campo === 'telefone' ? ' (obrigatório)' : ''}
                </dt>
                <dd>{CABECALHOS_ACEITOS[campo].join(' · ')}</dd>
              </div>
            ))}
          </dl>
        </details>

        {/*
          O modelo é gerado a partir do mesmo mapa de aliases que a detecção
          usa, então ele passa pela conferência por construção. Um arquivo
          escrito à mão poderia divergir do parser — e o produto entregaria à
          barbearia um arquivo que ele próprio recusa.
        */}
        <p className="cartao-balcao__texto">
          Não tem como exportar do sistema antigo?{' '}
          <a href="/admin/importar/modelo.csv">Baixe a planilha modelo</a> — preencha e envie aqui.
        </p>
      </section>
      ) : null}

      {/* Passo 2 — o preview, só quando existe um para conferir. */}
      {emPreview ? (
        <section className="importar__bloco">
          <h2 className="avisos__titulo">2. Confira antes de aplicar</h2>
          <p className="painel__sub">
            <strong>{emPreview.fileName}</strong>: {frase(emPreview.resumo)}.
          </p>

          <dl className="numeros">
            <div className="numero">
              <dt className="numero__rotulo">Vão entrar</dt>
              <dd className="numero__valor tabular">{emPreview.resumo.novo}</dd>
            </div>
            <div className="numero">
              <dt className="numero__rotulo">Já na base</dt>
              <dd className="numero__valor tabular">{emPreview.resumo.ja_existe}</dd>
            </div>
            <div className="numero">
              <dt className="numero__rotulo">Ficam de fora</dt>
              <dd className="numero__valor tabular">
                {emPreview.total - emPreview.resumo.novo - emPreview.resumo.ja_existe}
              </dd>
            </div>
          </dl>

          {(() => {
            const conflitos = emPreview.problemas
              .filter((linha) => linha.veredito === 'conflito')
              .map((linha) => ({
                linha: linha.linha,
                nomeAnterior: linha.conflitaCom ?? 'Nome anterior',
                nomeDaLinha: linha.nome,
                telefoneMascarado: mascararTelefone(linha.telefone),
              }));
            const outros = emPreview.problemas.filter((linha) => linha.veredito !== 'conflito');
            return (
              <>
                <ResolverConflitos conflitos={conflitos} importId={emPreview.id} />
                {outros.length > 0 ? (
                  <>
                    <h3 className="avisos__titulo">O que ainda fica de fora</h3>
                    <ul className="defeitos">
                      {outros.map((linha) => (
                        <Problema key={`${linha.linha}-${linha.telefone}`} linha={linha} />
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            );
          })()}

          <form action={acaoAplicarImportacao}>
            <input name="id" type="hidden" value={emPreview.id} />
            <button className="ui-button ui-button--primary ui-button--block" type="submit">
              Aplicar: trazer {emPreview.resumo.novo}{' '}
              {emPreview.resumo.novo === 1 ? 'cliente' : 'clientes'}
            </button>
          </form>

          <p className="painel__nota">
            Ninguém recebe mensagem por causa da importação. Quem entrar por aqui fica sem
            autorização de promoção até dizer que aceita — a autorização precisa de data e registro,
            e isso não vem no arquivo.
          </p>
        </section>
      ) : null}

      {/* Passo 3 — o histórico, que é também onde se desfaz. */}
      {podeImportar ? (
      <section className="importar__bloco">
        <h2 className="avisos__titulo">Importações desta barbearia</h2>
        {importacoes.length === 0 ? (
          <div className="vazio">
            <p className="vazio__titulo">Nenhuma ainda</p>
            <p className="vazio__saida">
              A primeira aparece aqui assim que você enviar um arquivo, mesmo antes de aplicar.
            </p>
          </div>
        ) : (
          <ul className="eventos">
            {importacoes.map((item) => (
              <Importacao fuso={estado.empresa.timezone} item={item} key={item.id} />
            ))}
          </ul>
        )}
      </section>
      ) : null}

      {enderecos?.ok ? <Enderecos slugs={enderecos.dados.slugs} /> : null}
    </main>
  );
}
