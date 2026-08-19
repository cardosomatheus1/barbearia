import type { Metadata } from 'next';

/**
 * A porta da frente do Barber Dock.
 *
 * ## O que esta página vende, e para quem
 *
 * Não é a página de uma barbearia — essa é `/{slug}`. Esta é a do **produto**,
 * e quem chega nela é o dono de uma barbearia que já usa alguma coisa e está
 * insatisfeito. Ele não quer ler "solução completa de gestão": quer saber se
 * isto resolve o problema que ele tem hoje.
 *
 * Daí a tese: **a seção mais importante é a do que costuma quebrar.** Cada linha
 * dela é um problema concreto da operação, com o efeito que ele tem no dia — o
 * oposto de uma parede de depoimentos. Ela fala do problema, nunca de um
 * concorrente com nome: o leitor está ali para reconhecer o próprio dia, não
 * para assistir alguém ser julgado.
 *
 * ## Zero JavaScript de cliente
 *
 * O produto inteiro é renderizado no servidor, e a landing não abre exceção. O
 * que no mock era JavaScript virou CSS: as abas viraram uma faixa que rola, o
 * "revelar ao rolar" saiu, e a paleta de comandos — que é enfeite de marketing —
 * não entrou. O que ficou de movimento é ambiente, e some inteiro em
 * `prefers-reduced-motion`.
 *
 * ## O elemento assinatura é a corda
 *
 * O selo tem um anel de cordame, e ele vira o divisor entre as seções — um filete
 * trançado desenhado em CSS. É o detalhe que não sai de um template: vem do
 * desenho da marca e não de uma paleta.
 */

export const metadata: Metadata = {
  title: 'Barber Dock — o porto da sua barbearia',
  description:
    'Agenda que respeita a duração real do serviço, balcão para quem chega sem marcar, comanda, caixa, fiado e comissão. Feito a partir do que quebra numa barbearia de verdade.',
};

/**
 * As telas do produto, fotografadas.
 *
 * ## Por que existe
 *
 * A página falava do sistema sem mostrá-lo. Quem chega aqui é dono de
 * barbearia insatisfeito com o que usa hoje, e a primeira pergunta dele é
 * visual: "com o que eu vou trabalhar?". Texto responde por último.
 *
 * ## Por que são fotos e não desenho
 *
 * Cada uma é um print do produto rodando, com a barbearia de demonstração que
 * `scripts/semear-demo.mjs` cria — os números na tela são os que o motor
 * calculou, não valores digitados num mock. Numa página cuja tese é "medimos,
 * não imaginamos", ilustrar com maquete seria contradizê-la na própria dobra.
 *
 * Refazer: suba o sistema, rode `node tirar-prints.cjs <segredo-do-2fa>` e
 * converta para 1200px de largura.
 *
 * ## Sem JavaScript, como o resto da landing
 *
 * A tira rola com `scroll-snap` e os atalhos são âncoras — o navegador já sabe
 * fazer as duas coisas. Abas de verdade exigiriam estado no cliente, e o
 * produto inteiro é renderizado no servidor.
 */
const TELAS = [
  {
    id: 'tela-dashboard',
    nome: 'Painel',
    arquivo: 'dashboard',
    alto: 'Painel do dono: faturamento do período, meta, ocupação e o que merece ação hoje',
    nota: 'Faturamento, meta e ocupação por período — com o que merece ação agora.',
  },
  {
    id: 'tela-dia',
    nome: 'O dia',
    arquivo: 'dia',
    alto: 'Painel do balcão com quem chegou, quem está na cadeira e quem faltou',
    nota: 'Quem chegou, quem está na cadeira e há quanto tempo. A linha do agora separa o que passou.',
  },
  {
    id: 'tela-marcar',
    nome: 'Marcar',
    arquivo: 'marcar',
    alto: 'Tela de marcação pelo balcão, com a grade de horários que cabem',
    nota: 'A grade sai da duração real do serviço — não de blocos fixos de quinze minutos.',
  },
  {
    id: 'tela-cliente',
    nome: 'Pelo cliente',
    arquivo: 'cliente-agendar',
    alto: 'Página pública da barbearia, com foto, endereço, serviços e preços',
    nota: 'Endereço, telefone, foto e preço. O cliente agenda sem instalar nada.',
  },
  {
    id: 'tela-comanda',
    nome: 'Comanda',
    arquivo: 'comanda',
    alto: 'Comanda aberta com itens do atendimento e as formas de pagamento',
    nota: 'Nasce preenchida com o que foi marcado, no preço combinado na reserva.',
  },
] as const;

const MODULOS = [
  {
    kicker: 'Agenda',
    titulo: 'O horário existe porque cabe',
    texto:
      'A grade sai da duração real de cada serviço, com buffer e recurso — não de blocos fixos de 15 minutos que deixam buraco morto entre um corte e outro.',
    classe: 'lp-bento__item--grande',
  },
  {
    kicker: 'Balcão',
    titulo: 'Quem chegou sem marcar',
    texto:
      'Fila de espera com posição pelo celular do cliente, encaixe com o custo visível antes de confirmar, e check-in que não depende do barbeiro largar a máquina.',
    classe: 'lp-bento__item--alto',
  },
  {
    kicker: 'Dinheiro',
    titulo: 'Comanda, caixa e fiado',
    texto:
      'Fechamento com divergência à mostra, sangria auditada por nome e fiado como forma de pagamento — não como comanda em aberto que ninguém cobra.',
    classe: 'lp-bento__item--largo',
  },
  {
    kicker: 'Comissão',
    titulo: 'Fecha e congela',
    texto:
      'O lançamento guarda a base e a regra copiada, nunca o valor. Período fechado vira imutável no banco, e estorno é lançamento novo — nunca um DELETE.',
    classe: 'lp-bento__item--pequeno',
  },
  {
    kicker: 'Avisos',
    titulo: 'Lembrete que respeita a noite',
    texto:
      'Confirmação, 24h, 2h e convite de retorno, com janela de silêncio das 21h às 8h no fuso da unidade — e teto de mensagem por mês, por pessoa.',
    classe: 'lp-bento__item--pequeno',
  },
] as const;

/**
 * O que costuma quebrar numa barbearia, e o que fazemos diferente.
 *
 * ## Por que sem sobrenome
 *
 * A versão anterior contava que o sistema de uma barbearia identificável tinha
 * sido auditado, listava os achados com o código do dossiê e dizia quanto cada
 * um custava a ela. Era verdade e era verificável — e expunha a barbearia e o
 * fornecedor dela numa página de vendas. O leitor não estava aprendendo sobre o
 * problema dele; estava assistindo alguém ser julgado.
 *
 * O conteúdo continua sendo o mesmo, porque ele **é** de categoria: grade fixa,
 * fuso do aparelho, combo com duração errada e página sem endereço aparecem em
 * software de barbearia inteiro, não num só. O que saiu foi o dedo apontado.
 *
 * ## O que não pode sair junto
 *
 * A concretude. "Serviço de 20 min começava 09:15 e deixava buraco" é o que faz
 * um dono reconhecer o próprio dia; trocar por "otimize sua agenda" transforma
 * a seção na parede de marketing que ela existe para não ser.
 */
const ACHADOS = [
  {
    area: 'Agenda',
    problema: 'A grade é fixa de 15 em 15, independente do serviço.',
    efeito: 'Um corte de 20 min começa 09:15 e deixa cinco minutos que ninguém preenche.',
    resposta: 'A grade sai da duração de cada serviço. Sobrou janela, ela é oferecida.',
  },
  {
    area: 'Cardápio',
    problema: '"Cabelo + Barba" cadastrado com 30 min, quando as partes somam 40.',
    efeito: 'Dez minutos de atraso por atendimento, acumulando o dia inteiro.',
    resposta: 'Um validador confere o cardápio e mostra a diferença entre a duração cadastrada e a real.',
  },
  {
    area: 'Fuso',
    problema: 'O horário mostrado vem do relógio do aparelho de quem acessa.',
    efeito: 'Celular com relógio torto vê a grade deslocada e marca no horário errado.',
    resposta: 'O fuso é o da unidade, sempre. O aparelho não opina sobre que horas são na barbearia.',
  },
  {
    area: 'Escolha',
    problema: 'É preciso escolher o profissional antes de ver qualquer horário.',
    efeito: 'Quem só quer o mais cedo possível abre um barbeiro de cada vez para comparar.',
    resposta: '"Qualquer profissional" é a primeira opção, e mostra o horário mais cedo de todos.',
  },
  {
    area: 'Página',
    problema: 'A página de agendamento não traz endereço, mapa, telefone nem horário.',
    efeito: 'Metade de quem entra quer saber onde fica e se está aberto — não agendar.',
    resposta: 'A página pública responde as três coisas antes de pedir qualquer toque.',
  },
  {
    area: 'Cadastro',
    problema: 'Conta de balcão entra no sistema como se fosse mais um barbeiro.',
    efeito: 'Ocupação e comissão saem poluídas por uma agenda que não é de ninguém.',
    resposta: 'Cadeira tem tipo. Conta de balcão não vira barbeiro no relatório.',
  },
] as const;

const SUPERFICIES = [
  {
    nome: 'O cliente',
    aparelho: 'celular, em pé, na rua',
    texto:
      'Entra pelo link da bio, vê horário livre já tocável e agenda sem criar conta. Volta com um código de seis dígitos para remarcar ou cancelar.',
  },
  {
    nome: 'O balcão',
    aparelho: 'notebook aberto o dia inteiro',
    texto:
      'O dia inteiro numa tela: quem chegou, quem está atrasado, quem falta atender. Marca para quem apareceu sem horário sem sair da mesma página.',
  },
  {
    nome: 'O barbeiro',
    aparelho: 'celular, entre um cliente e outro',
    texto:
      'O próximo da cadeira, a ficha de quem vai sentar — "não usar navalha" — e os próprios números, comparados com o próprio mês passado.',
  },
  {
    nome: 'O dono',
    aparelho: 'onde estiver',
    texto:
      'Faturamento, ocupação e falta com comparação contra o mesmo dia da semana anterior. Número sem comparação não decide nada.',
  },
] as const;

export default function LandingPage() {
  return (
    <div className="lp">
      {/* Fundo: malha fina e feixes verticais. Puramente decorativo, fora do fluxo. */}
      <div aria-hidden="true" className="lp-ambiente">
        <span className="lp-feixe lp-feixe--1" />
        <span className="lp-feixe lp-feixe--2" />
        <span className="lp-feixe lp-feixe--3" />
      </div>

      <header className="lp-nav">
        <div className="lp-nav__interno">
          <a className="lp-marca" href="/">
            <img
              alt="Barber Dock"
              className="lp-marca__selo"
              height={384}
              src="/barber-dock.png"
              width={384}
            />
            <span className="lp-marca__nome">
              Barber Dock
              <small>Sistema de gestão</small>
            </span>
          </a>

          <div className="lp-nav__acoes">
            <a className="ui-button ui-button--ghost" href="/admin/entrar">
              Entrar
            </a>
            <a className="ui-button ui-button--primary lp-beam" href="/admin/criar-conta">
              Criar conta
            </a>
          </div>

          {/* No celular as âncoras viram uma faixa que rola dentro de si — não
              somem. Esconder no aparelho pequeno seria decidir que não
              importavam; se não importam, saem de todas as larguras. */}
          <nav aria-label="Seções" className="lp-nav__links ui-scroll-x">
            <a href="#telas">Telas</a>
            <a href="#recursos">Recursos</a>
            <a href="#campo">O que quebra</a>
            <a href="#superficies">Quem usa</a>
          </nav>
        </div>
      </header>

      <main>
        <section className="lp-heroi">
          <div className="lp-container lp-heroi__grade">
            <div>
              <p className="lp-selo">
                <span aria-hidden="true" className="lp-selo__ponto" />
                ERP para barbearia
              </p>

              <h1 className="lp-heroi__titulo">
                Seu porto seguro
                <br />
                na <em>gestão</em>
              </h1>

              <p className="lp-heroi__texto">
                Agenda que respeita a duração real do serviço, balcão para quem chega sem marcar,
                comanda, caixa, fiado e comissão. Construído a partir do que quebra numa barbearia
                de verdade — não do que cabe numa apresentação.
              </p>

              <div className="lp-heroi__acoes">
                <a className="ui-button ui-button--primary ui-button--lg lp-beam" href="/admin/criar-conta">
                  Abrir minha barbearia
                </a>
                <a className="lp-link" href="#campo">
                  Ver o que costuma quebrar
                  <span aria-hidden="true">→</span>
                </a>
              </div>

              <ul className="lp-provas">
                <li>Sem instalação — abre no navegador</li>
                <li>Traz sua base de clientes por planilha</li>
                <li>Cada barbearia isolada no banco</li>
              </ul>
            </div>

            {/* A janela é HTML de verdade, não print: o que aparece aqui é o
                mesmo vocabulário da tela do balcão, e não envelhece sozinho
                quando a tela mudar. Fica em perspectiva, com o brilho varrendo
                a tela e os cartões de vidro por cima — é o volume que separa
                uma página de produto de uma folha de texto. */}
            <div className="lp-palco" aria-hidden="true">
              {/* A coluna dos cartões. Escalonada de propósito: alinhados entre
                  si eles viram uma tabela; desalinhados, leem como flutuando. */}
              <div className="lp-palco__pilha">
                <div className="lp-flutuante lp-flutuante--1">
                  <span className="lp-flutuante__rotulo">Ocupação hoje</span>
                  <strong className="lp-flutuante__valor tabular">87%</strong>
                  <span className="lp-flutuante__delta">+12% que sábado passado</span>
                </div>
                <div className="lp-flutuante lp-flutuante--2">
                  <span className="lp-flutuante__rotulo">Na fila</span>
                  <strong className="lp-flutuante__valor tabular">3</strong>
                  <span className="lp-flutuante__delta">espera média 14 min</span>
                </div>
                <div className="lp-flutuante lp-flutuante--3">
                  <span className="lp-flutuante__rotulo">Caixa do dia</span>
                  <strong className="lp-flutuante__valor tabular">R$ 5.820</strong>
                  <span className="lp-flutuante__delta">ticket R$ 69,28</span>
                </div>
              </div>

              <div className="lp-janela">
                <div className="lp-janela__barra">
                  <span className="lp-janela__sinais">
                    <i /><i /><i />
                  </span>
                  <span className="lp-janela__url">barberdock.app/admin/dia</span>
                </div>

                <div className="lp-janela__corpo">
                  <p className="lp-janela__dia">
                    Sábado <span className="tabular">14/03</span>
                  </p>

                  <ul className="lp-agenda">
                    <li className="lp-agenda__linha lp-agenda__linha--feito">
                      <span className="lp-agenda__hora tabular">09:00</span>
                      <span className="lp-agenda__quem">Carlos Souza</span>
                      <span className="lp-agenda__estado">Concluído</span>
                    </li>
                    <li className="lp-agenda__linha lp-agenda__linha--agora">
                      <span className="lp-agenda__hora tabular">09:40</span>
                      <span className="lp-agenda__quem">José Antônio</span>
                      <span className="lp-agenda__estado">Em atendimento</span>
                    </li>
                    <li className="lp-agenda__linha lp-agenda__linha--atrasado">
                      <span className="lp-agenda__hora tabular">10:20</span>
                      <span className="lp-agenda__quem">Bruno Carvalho</span>
                      <span className="lp-agenda__estado">Atrasado 6 min</span>
                    </li>
                    <li className="lp-agenda__linha">
                      <span className="lp-agenda__hora tabular">11:00</span>
                      <span className="lp-agenda__quem">Livre</span>
                      <span className="lp-agenda__estado">Encaixe</span>
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* `ui-sangra`: a faixa é max-content e animada de propósito — não há
            conteúdo a alcançar atrás do recorte. */}
        <div className="lp-faixa ui-sangra">
          <div className="lp-faixa__trilho">
            {/* Duplicado para o laço não ter emenda visível. */}
            {[0, 1].map((volta) => (
              <span className="lp-faixa__grupo" key={volta}>
                <span>Agenda</span>
                <span>Fila de espera</span>
                <span>Comanda</span>
                <span>Caixa</span>
                <span>Fiado</span>
                <span>Comissão</span>
                <span>Avisos no WhatsApp</span>
                <span>Ficha do cliente</span>
                <span>Metas por barbeiro</span>
                <span>Trilha de auditoria</span>
              </span>
            ))}
          </div>
        </div>

        <section className="lp-secao lp-secao--placar">
          <div className="lp-container">
            <dl className="lp-placar">
              <div className="lp-placar__item">
                <dt>Blocos entregues</dt>
                <dd className="tabular">22</dd>
              </div>
              <div className="lp-placar__item">
                <dt>Problemas levantados em operação real</dt>
                <dd className="tabular">12</dd>
              </div>
              <div className="lp-placar__item">
                <dt>Piso de tela conferido</dt>
                <dd className="tabular">360px</dd>
              </div>
              <div className="lp-placar__item">
                <dt>JavaScript no celular do cliente</dt>
                <dd className="tabular">0 kB</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="lp-secao" id="telas">
          <div className="lp-container">
            <p className="lp-sobrancelha">Por dentro do sistema</p>
            <h2 className="lp-titulo">Veja o Barber Dock funcionando</h2>
            <p className="lp-intro">
              Fotos do produto rodando, com a barbearia de demonstração que acompanha o código —
              os números são os que o motor calculou. Deslize para o lado, ou use os atalhos.
            </p>

            {/* Âncoras, não abas: o navegador rola até o alvo sem uma linha de
                JavaScript. Cada uma é um alvo de 44px, como qualquer outro. */}
            <nav aria-label="Telas do sistema" className="lp-telas__atalhos ui-scroll-x">
              {TELAS.map((tela) => (
                <a className="lp-telas__atalho" href={`#${tela.id}`} key={tela.id}>
                  {tela.nome}
                </a>
              ))}
            </nav>
          </div>

          {/* Rola dentro de si, nunca leva a página junto (CLAUDE.md §5). */}
          <ul className="lp-telas ui-scroll-x">
            {TELAS.map((tela, indice) => (
              <li className="lp-telas__item" id={tela.id} key={tela.id}>
                <figure className="lp-telas__figura">
                  {/* `width`/`height` no elemento **e** `aspect-ratio` no CSS: sem os
                      dois o navegador não reserva o espaço e a foto empurra o
                      conteúdo ao carregar. */}
                  <img
                    alt={tela.alto}
                    className="lp-telas__foto"
                    height={750}
                    loading="lazy"
                    src={`/screens/${tela.arquivo}.jpg`}
                    width={1200}
                  />
                  <figcaption className="lp-telas__legenda">
                    <span className="lp-telas__ordem tabular">
                      {String(indice + 1).padStart(2, '0')}
                    </span>
                    <span>
                      <strong className="lp-telas__nome">{tela.nome}</strong>
                      <span className="lp-telas__nota">{tela.nota}</span>
                    </span>
                  </figcaption>
                </figure>
              </li>
            ))}
          </ul>
        </section>

        <section className="lp-secao" id="recursos">
          <div className="lp-container">
            <p className="lp-sobrancelha">O que o sistema faz</p>
            <h2 className="lp-titulo">Do primeiro horário ao fechamento do caixa</h2>
            <p className="lp-intro">
              Cinco frentes que uma barbearia usa todo dia, integradas — não módulos vendidos
              separados que não conversam entre si.
            </p>

            <div className="lp-bento">
              {MODULOS.map((modulo) => (
                <article className={`lp-bento__item ${modulo.classe}`} key={modulo.kicker}>
                  <p className="lp-bento__kicker">{modulo.kicker}</p>
                  <h3 className="lp-bento__titulo">{modulo.titulo}</h3>
                  <p className="lp-bento__texto">{modulo.texto}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <hr aria-hidden="true" className="lp-corda" />

        <section className="lp-secao" id="campo">
          <div className="lp-container">
            <p className="lp-sobrancelha">O que costuma quebrar</p>
            <h2 className="lp-titulo">
              Seis coisas que a gente <em>mediu</em>, não imaginou
            </h2>
            <p className="lp-intro">
              Antes da primeira linha de código, doze problemas foram levantados dentro de uma
              barbearia em funcionamento — com cronômetro, não com suposição. Eles não são de um
              software: são o que se repete na categoria. Seis estão abaixo, com o que cada um
              custa no dia e o que fazemos diferente.
            </p>

            <ul className="lp-achados">
              {ACHADOS.map((achado) => (
                <li className="lp-achado" key={achado.area}>
                  <p className="lp-achado__codigo">{achado.area}</p>
                  <div className="lp-achado__corpo">
                    <p className="lp-achado__problema">{achado.problema}</p>
                    <p className="lp-achado__efeito">{achado.efeito}</p>
                    <p className="lp-achado__resposta">{achado.resposta}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <hr aria-hidden="true" className="lp-corda" />

        <section className="lp-secao" id="superficies">
          <div className="lp-container">
            <p className="lp-sobrancelha">Quem usa</p>
            <h2 className="lp-titulo">Quatro pessoas, quatro telas, um sistema</h2>
            <p className="lp-intro">
              A mesma tela serve celular e notebook — o que muda é a densidade, não a regra. Nada de
              versão reduzida para quem está no aparelho pequeno.
            </p>

            <div className="lp-superficies">
              {SUPERFICIES.map((superficie) => (
                <article className="lp-superficie" key={superficie.nome}>
                  <h3 className="lp-superficie__nome">{superficie.nome}</h3>
                  <p className="lp-superficie__aparelho">{superficie.aparelho}</p>
                  <p className="lp-superficie__texto">{superficie.texto}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-secao lp-secao--final">
          <div className="lp-container">
            <div className="lp-chamada">
              <div>
                <h2 className="lp-chamada__titulo">Atracar leva um domingo à tarde</h2>
                <p className="lp-chamada__texto">
                  Cadastro em seis etapas, sua base de clientes por planilha e o endereço antigo
                  continuando a funcionar. Sem contrato de fidelidade e sem instalar nada.
                </p>
              </div>
              <div className="lp-chamada__acoes">
                <a className="ui-button ui-button--primary ui-button--lg lp-beam" href="/admin/criar-conta">
                  Criar conta
                </a>
                <a className="ui-button ui-button--secondary ui-button--lg" href="/admin/entrar">
                  Já sou cliente
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-rodape">
        <div className="lp-container lp-rodape__interno">
          <p>Barber Dock — sistema de gestão para barbearias</p>
          <nav aria-label="Rodapé" className="lp-rodape__links">
            <a href="/admin/entrar">Entrar</a>
            <a href="/admin/criar-conta">Criar conta</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
