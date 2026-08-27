import type { Metadata } from 'next';

/**
 * Os termos de serviço do produto (bloco 136).
 *
 * ## Por que ela existe
 *
 * A Meta exige **URL pública** de termos de serviço para aprovar um app na App
 * Review, ao lado da política de privacidade, e a conferência é automática
 * antes de qualquer humano olhar. O campo estava preenchido com
 * `https://www.facebook.com/` — o texto que a própria Meta deixa como exemplo —,
 * o que reprova a submissão e, pior, não diz a ninguém o que foi contratado.
 *
 * ## A regra que organiza o texto
 *
 * **Nada aqui promete o que o produto não faz.** É a mesma disciplina de
 * `docs/comercial/prontidao.md`, e por isso esta página entra na varredura R8:
 * split automático, NFS-e real e cobrança online do sinal estão `❌` na matriz
 * do `ROADMAP.md`, e um contrato que os prometesse seria a única superfície
 * comercial do produto capaz de gerar obrigação jurídica em cima de uma
 * integração que não existe.
 *
 * Por isso a seção 8 diz em letras o que **não** está disponível. É incomum num
 * contrato e é o mesmo princípio do gatilho que aparece marcado em vez de
 * escondido: esconder faz a barbearia descobrir depois de assinar.
 *
 * ## Números vêm do código, não da memória
 *
 * A régua de cobrança desta página é a de `packages/core/src/cobranca.ts` —
 * aviso 3 dias antes, `past_due` no vencimento, retentativa em D+1, D+3, D+7 e
 * D+14, bloqueio em D+21. Escrevi a do clube de assinatura por engano na
 * primeira versão (a que pausa aos quinze dias), que é outra régua, de outro
 * produto, dentro do mesmo repositório.
 */

export const metadata: Metadata = {
  title: 'Termos de Serviço — Barber Dock',
  description:
    'O que o Barber Dock entrega, como funciona a assinatura, o que acontece quando uma fatura vence e o que ainda não está disponível.',
};

/** Muda quando o texto muda, e é o que separa duas versões numa discussão. */
const VERSAO = '2026-08';

export default function TermosPage() {
  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-nav__interno">
          <a className="lp-marca" href="/">
            {/* `width`/`height` no `<img>` e `aspect-ratio` no CSS: sem os dois o
                navegador não reserva o espaço e a marca empurra o texto ao
                carregar. */}
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
        </div>
      </header>

      <main className="lp-container legal">
        <h1 className="legal__titulo">Termos de Serviço</h1>
        <p className="legal__meta">
          Versão {VERSAO}. Valem para o site barberdock.com.br, para o painel de gestão, para a
          página pública da barbearia e para o canal de WhatsApp operado pelo produto.
        </p>

        <h2 className="legal__secao">1. O que é o Barber Dock</h2>
        <p>
          O Barber Dock é um sistema de gestão para barbearias, fornecido como serviço por
          assinatura. Ele cuida de agenda, atendimento, comanda, caixa, comissão, base de
          clientes, estoque e relatórios, e publica uma página onde o cliente final marca
          horário.
        </p>
        <p>
          Quem contrata é a <strong>barbearia</strong> — empresa ou profissional autônomo. Estes
          termos são o acordo entre ela e o Barber Dock. O cliente que marca um corte não
          contrata nada conosco: ele contrata a barbearia.
        </p>
        <p>
          &quot;Barber Dock&quot; é o nome comercial do produto. Ele é operado por{' '}
          <strong>Steakhome</strong>, inscrita no CNPJ sob o nº{' '}
          <strong>37.344.763/0001-60</strong>, com sede em Salvador, Bahia — a parte destes
          termos, e a mesma empresa que emite a nota fiscal da assinatura.
        </p>

        <h2 className="legal__secao">2. Conta, acesso e responsabilidade</h2>
        <p>
          A conta do dono é criada no cadastro e é a única que não pode ser trancada para fora do
          próprio negócio. A partir dela, a barbearia cria as contas da equipe e decide o que cada
          papel pode fazer.
        </p>
        <p>
          <strong>A barbearia responde pelo que suas contas fazem.</strong> Quem tem acesso ao
          painel enxerga dado de cliente, movimenta caixa e manda mensagem em nome da casa —
          conceder acesso é uma decisão dela, e o sistema registra quem fez o quê.
        </p>
        <p>
          Operações que movem dinheiro podem exigir um segundo fator de autenticação. A barbearia
          decide se essa exigência vale para ela; a lista de operações cobertas é do produto, e não
          é editável.
        </p>

        <h2 className="legal__secao">3. Assinatura e cobrança</h2>
        <p>
          A assinatura é mensal, com o valor do plano contratado. O ciclo é ancorado no dia da
          adesão, não no primeiro dia do mês, e cada ciclo gera uma fatura com o valor congelado
          no momento da emissão — mudar de plano não reescreve fatura já emitida.
        </p>
        <p>
          A cobrança é processada por um adquirente contratado pela plataforma. Os dados do cartão
          ficam com ele: deste lado guardamos apenas a bandeira, os quatro últimos dígitos e uma
          referência opaca que não permite cobrar nada por conta própria.
        </p>

        <h2 className="legal__secao">4. O que acontece quando uma fatura não é paga</h2>
        <p>
          O produto <strong>não</strong> sai do ar no dia do vencimento, e isso é decisão de
          desenho: a barbearia tem agenda marcada para os próximos dias, e derrubá-la cancela o
          dia de trabalho de gente que não decidiu nada sobre pagamento.
        </p>
        <ul className="legal__lista">
          <li>três dias antes do vencimento, o dono é avisado;</li>
          <li>
            no vencimento, a assinatura passa a <strong>vencida</strong> e o sistema continua
            funcionando normalmente;
          </li>
          <li>
            a cobrança é retentada 1, 3, 7 e 14 dias depois do vencimento — a escada cresce porque
            a causa muda: no primeiro dia costuma ser limite ou saldo, na segunda semana já é
            cartão cancelado;
          </li>
          <li>
            <strong>21 dias</strong> depois do vencimento, o acesso é bloqueado.
          </li>
        </ul>
        <p>
          Bloqueio não apaga nada. Os dados continuam e voltam a ser acessíveis assim que a
          pendência for quitada. Exportação da base de clientes continua disponível ao dono
          enquanto a conta existir.
        </p>

        <h2 className="legal__secao">5. Cancelamento</h2>
        <p>
          A barbearia pode cancelar quando quiser, pelo painel. O cancelamento vale do{' '}
          <strong>fim do período já pago</strong> — não cortamos no dia do pedido: ficar com o
          dinheiro do mês e não entregar o mês seria cobrar por serviço não prestado.
        </p>
        <p>
          Cancelar não bloqueia o acesso. Até o fim do período pago, tudo continua funcionando.
        </p>

        <h2 className="legal__secao">6. WhatsApp</h2>
        <p>
          As mensagens saem pelo <strong>número da própria barbearia</strong>, verificado por ela
          junto à Meta. A barbearia é quem envia; o Barber Dock é a ferramenta.
        </p>
        <p>
          O uso desse canal está sujeito às regras da Meta, que são dela e podem mudar sem que
          tenhamos como impedir: aprovação de cada texto antes do envio, suspensão de textos com
          índice de qualidade baixo e limites de envio por conta. Quando a Meta recusa ou pausa
          algo, o painel mostra o motivo que ela devolveu.
        </p>
        <p>
          Promoção exige autorização separada do cliente, e nada é enviado entre 21h e 8h no fuso
          da barbearia.
        </p>

        <h2 className="legal__secao">7. Marketplace e comissão por cliente novo</h2>
        <p>
          A barbearia pode aparecer na busca pública do Barber Dock. Quando um cliente{' '}
          <strong>que ela ainda não tinha</strong> chega por ali e fecha um atendimento, é devida
          comissão sobre aquela venda, na alíquota contratada.
        </p>
        <p>
          <strong>Nunca cobramos por cliente que já era dela.</strong> Isso não é promessa de
          texto: quem impõe é o próprio banco de dados, que aceita uma única atribuição por
          cliente e por barbearia. A barbearia pode contestar uma cobrança pelo painel, e a
          contestação é registrada com motivo.
        </p>

        <h2 className="legal__secao">8. O que ainda não está disponível</h2>
        <p>
          Três recursos existem no sistema como motor e tela, e <strong>dependem de contrato
          externo que ainda não está firmado</strong>. Eles não fazem parte do que está sendo
          contratado hoje, e estão escritos aqui para que ninguém descubra isso depois:
        </p>
        <ul className="legal__lista">
          <li>
            <strong>repartição automática do pagamento com o profissional</strong> — a comissão é
            calculada e aparece no fechamento, mas o dinheiro não é repartido pelo adquirente;
          </li>
          <li>
            <strong>emissão de nota fiscal de serviço junto à prefeitura</strong> — o fluxo está
            preparado e depende de emissor contratado;
          </li>
          <li>
            <strong>cobrança do sinal do agendamento pela internet</strong> — o sistema decide
            quando pedir sinal e quanto, e a cobrança em si é combinada fora dele.
          </li>
        </ul>
        <p>
          Quando qualquer um deles passar a funcionar, esta seção muda e a versão no topo muda
          junto.
        </p>

        <h2 className="legal__secao">9. Disponibilidade</h2>
        <p>
          Trabalhamos para manter o serviço no ar, sem prometer um percentual que não medimos
          publicamente. Manutenções e indisponibilidade de terceiros — adquirente, Meta,
          provedor de infraestrutura — podem afetar partes do produto, e o painel diz o que está
          fora quando sabe.
        </p>
        <p>
          Cópias de segurança são feitas e mantidas cifradas. Elas existem para recuperar o
          serviço, não como arquivo de consulta.
        </p>

        <h2 className="legal__secao">10. Dados pessoais</h2>
        <p>
          A barbearia é <strong>controladora</strong> dos dados dos clientes dela; o Barber Dock é{' '}
          <strong>operador</strong>, e trata esses dados seguindo as instruções dela. Não vendemos
          base de clientes, não usamos os dados de uma barbearia para outra e não mandamos
          mensagem por conta própria para a base de ninguém.
        </p>
        <p>
          O detalhe está na{' '}
          <a href="/privacidade">Política de Privacidade</a>, que faz parte destes termos.
        </p>

        <h2 className="legal__secao">11. Uso aceitável</h2>
        <p>
          A barbearia se compromete a não usar o produto para mandar mensagem a quem não
          autorizou, importar base que não é dela, contornar limites técnicos do sistema ou dos
          serviços de terceiros que ele usa, nem para atividade ilícita.
        </p>
        <p>
          Descumprimento pode levar à suspensão do acesso. Quando isso acontecer, dizemos o motivo
          — suspensão sem explicação não é ferramenta que usamos.
        </p>

        <h2 className="legal__secao">12. Limite de responsabilidade</h2>
        <p>
          O Barber Dock responde pelo funcionamento do sistema. Ele não responde pelas decisões
          comerciais da barbearia, pelo atendimento prestado ao cliente final, pelo conteúdo que
          a barbearia escreve e envia, nem pelas obrigações fiscais e trabalhistas dela.
        </p>
        <p>
          Nada aqui afasta direitos que a lei brasileira garante ao consumidor ou ao titular de
          dados pessoais.
        </p>

        <h2 className="legal__secao">13. Mudanças nestes termos</h2>
        <p>
          Quando este texto mudar, a versão no topo muda junto. Mudança que altere preço, prazo
          ou o que está sendo entregue é avisada antes de valer, pelos canais da conta.
        </p>

        <h2 className="legal__secao">14. Lei aplicável e foro</h2>
        <p>
          Aplica-se a lei brasileira. Fica eleito o foro da comarca de Salvador, Bahia, para as
          questões que não se resolverem entre as partes.
        </p>

        <h2 className="legal__secao">15. Contato</h2>
        <p>
          <a href="mailto:contato@barberdock.com.br">contato@barberdock.com.br</a>. Para assuntos
          de privacidade,{' '}
          <a href="mailto:privacidade@barberdock.com.br">privacidade@barberdock.com.br</a>.
        </p>
      </main>

      <footer className="lp-rodape">
        <div className="lp-container lp-rodape__interno">
          <p>Barber Dock — sistema de gestão para barbearias</p>
          <nav aria-label="Rodapé" className="lp-rodape__links">
            <a href="/">Início</a>
            <a href="/privacidade">Privacidade</a>
            <a href="/admin/entrar">Entrar</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
