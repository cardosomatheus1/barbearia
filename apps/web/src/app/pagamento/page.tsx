import type { Metadata } from 'next';

/**
 * Onde a Stripe deixa quem pagou por link.
 *
 * Quem chega aqui não está no balcão e pode nem ter cadastro: recebeu um
 * endereço por WhatsApp, abriu, pagou. A página existe porque a Stripe **exige**
 * `success_url` — sem ela o checkout nem é criado, e foi assim que o meio
 * "link" ficou quebrado desde que foi escrito.
 *
 * ## O que ela não afirma
 *
 * Não diz "pago". A Stripe redireciona assim que o checkout termina, e o banco
 * ainda pode estar confirmando — dizer que está pago aqui seria a tela mentindo
 * no único momento em que a pessoa está olhando para o próprio dinheiro. Quem
 * confirma é o webhook, e é ele que fecha a comanda.
 *
 * Também não lê nada: o id da sessão é bem parecido com um segredo ao portador,
 * e uma página pública que consultasse o estado por ele entregaria o valor e a
 * descrição da venda a quem tivesse o link. O que a pessoa precisa saber cabe
 * em duas frases.
 */

export const metadata: Metadata = {
  title: 'Pagamento',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const primeiro = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

export default async function Pagamento({ searchParams }: Props) {
  const query = await searchParams;
  const concluido = primeiro(query['pago']) === '1';

  return (
    <main className="ui-container recibo">
      <div className="recibo__cartao">
        <svg
          aria-hidden="true"
          className="recibo__marca"
          fill="none"
          height={40}
          viewBox="0 0 24 24"
          width={40}
        >
          <path
            d={concluido ? 'M4 12.5l5.5 5.5L20 7' : 'M12 3v11M12 19h.01'}
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </svg>
        <h1 className="recibo__titulo">
          {concluido ? 'Recebemos seu pagamento' : 'Pagamento não concluído'}
        </h1>
        <p className="recibo__texto">
          {concluido
            ? 'Assim que o banco confirmar, a barbearia é avisada automaticamente. Você já pode fechar esta página.'
            : 'Nada foi cobrado. O link continua valendo — é só abrir de novo, ou falar com a barbearia se preferir pagar de outro jeito.'}
        </p>
      </div>
    </main>
  );
}
