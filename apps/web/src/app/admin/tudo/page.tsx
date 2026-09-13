import { redirect } from 'next/navigation';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoSair } from '../acoes';
import { indicePorRitmo, modulosVisiveis, secao } from '../secoes';
import styles from './pagina.module.css';

export const metadata = { title: 'Todas as telas', robots: { index: false, follow: false } };

/**
 * O mapa do painel numa tela só.
 *
 * O trilho mostra sete ícones e a faixa mostra as telas **do módulo em que você
 * está**. Para responder "onde fica X?" sem saber o módulo, só clicando os sete
 * — e foi assim que o dono do produto se perdeu apresentando ao próprio cliente.
 * A busca global resolve para quem sabe que ela existe; quem chega pela primeira
 * vez não sabe.
 *
 * Agrupado por **ritmo** e não por módulo de propósito: por módulo, esta tela
 * seria o mesmo menu numa página, e o primeiro contato continuaria sendo com
 * quarenta destinos de peso igual. Por ritmo, a primeira leitura ensina a forma
 * do produto — são oito telas que dão conta do dia. O módulo continua escrito em
 * cada porta, que é o que liga este mapa ao trilho que a pessoa vai usar depois.
 *
 * Nada foi movido para esta tela existir. Quem já aprendeu um caminho continua
 * com ele.
 */
export default async function TudoPage() {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const modulos = modulosVisiveis(estado.recursos, estado.staff.permissions);
  const ritmos = indicePorRitmo(modulos);
  const quantas = ritmos.reduce((soma, ritmo) => soma + ritmo.portas.length, 0);

  return (
    <main className="ui-container painel__conteudo" {...secao('tudo')}>
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
      <h1 className="painel__titulo">Todas as telas</h1>
      <p className={styles.intro}>
        {quantas === 0
          ? 'Seu acesso ainda não abre nenhuma tela. Peça ao dono da barbearia para liberar o que você precisa usar.'
          : `As ${quantas} telas que o seu acesso abre, na ordem em que você as usa. Não precisa decorar: a busca no topo acha qualquer uma pelo nome.`}
      </p>

      {ritmos.map((ritmo) => (
        <section aria-labelledby={`ritmo-${ritmo.id}`} className={`${styles.ritmo} ${styles.area}`} key={ritmo.id}>
          <div className={styles.cabeca}>
            <h2 className={styles.titulo} id={`ritmo-${ritmo.id}`}>{ritmo.nome}</h2>
            <span className={styles.quantas}>
              {ritmo.portas.length} {ritmo.portas.length === 1 ? 'tela' : 'telas'}
            </span>
          </div>
          <p className={styles.quando}>{ritmo.quando}</p>
          <ul className={styles.lista}>
            {ritmo.portas.map((porta) => (
              <li className={styles.item} key={porta.secao}>
                <a className={styles.porta} href={porta.href}>
                  <span className={styles.onde}>{porta.onde}</span>
                  <span className={styles.nome}>{porta.nome}</span>
                  <span className={styles.nota}>{porta.nota}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
