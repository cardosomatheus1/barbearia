/**
 * A regra de cancelamento em uma frase.
 *
 * Vive num só lugar porque aparece em duas telas — a página pública e o
 * comprovante — e as duas precisam dizer exatamente o mesmo que o servidor
 * aplica. Duas cópias do texto divergem na primeira vez que alguém ajusta uma
 * delas, e quem lê a página é quem sai perdendo.
 *
 * O número vem de `locations.cancel_min_hours`, não do texto livre da
 * barbearia: só a coluna é aplicada.
 */
export function regraDeCancelamento(horas: number): string {
  if (horas <= 0) return 'Dá para cancelar até a hora do atendimento.';
  return `Cancele com pelo menos ${horas === 1 ? '1 hora' : `${horas} horas`} de antecedência.`;
}

/**
 * A versão do texto de consentimento de marketing (bloco 31).
 *
 * Constante e versionada num lugar só, porque é ela que fica gravada com a
 * decisão do titular. **Mudar o texto exige mudar a versão** — uma decisão
 * tomada sob "receber promoções e novidades" não é a mesma tomada sob um texto
 * que amanhã inclua compartilhamento com terceiros, e a versão é o que separa
 * as duas numa contestação.
 */
export const VERSAO_DO_CONSENTIMENTO = 'marketing-2026-08';

export const TEXTO_DO_CONSENTIMENTO =
  'Quero receber promoções e novidades desta barbearia por WhatsApp.';

/**
 * Os aceites **opcionais**, cada um com o seu texto — e agora nas duas telas.
 *
 * O nome era `CONSENTIMENTOS_DO_BALCAO` enquanto só a ficha os registrava. Desde
 * o bloco 129 o titular decide sozinho em `/{slug}/meus-agendamentos`, e a mesma
 * lista serve as duas: um segundo arranjo com os mesmos três textos seria a
 * lista paralela de sempre, e a divergência apareceria como o cliente aceitando
 * um texto e o balcão registrando outro — com a versão gravada mentindo sobre o
 * que ele leu.
 *
 * Três e não um, porque a SPEC §1.8 os separa e a LGPD também: quem autoriza
 * uma foto na ficha não autorizou a foto no Instagram, e quem quer receber
 * promoção não autorizou nenhuma das duas. Um consentimento único ("aceito
 * tudo") é o que a lei chama de consentimento genérico, e não vale.
 *
 * `service` fica de fora: é o tratamento necessário para executar o serviço
 * contratado, que não depende de consentimento e sim da própria execução do
 * contrato. Pedir aceite para ele confundiria o cliente sobre o que é
 * opcional — e é justamente a distinção que o resto desta lista preserva.
 */
export const CONSENTIMENTOS_OPCIONAIS = [
  {
    finalidade: 'marketing',
    titulo: 'Promoções por WhatsApp',
    texto: TEXTO_DO_CONSENTIMENTO,
    versao: VERSAO_DO_CONSENTIMENTO,
  },
  {
    finalidade: 'photos',
    titulo: 'Foto do corte na ficha',
    texto: 'Autorizo fotografar o meu corte para ficar guardado na minha ficha.',
    versao: 'fotos-2026-08',
  },
  {
    finalidade: 'photos_public',
    titulo: 'Foto nas redes da barbearia',
    texto: 'Autorizo a barbearia a publicar fotos do meu corte nas redes dela.',
    versao: 'fotos-publicas-2026-08',
  },
] as const;

/**
 * A versão é do texto, e cada finalidade tem o seu.
 *
 * Gravar `marketing-2026-08` numa decisão sobre foto diria que a pessoa
 * concordou com um texto que não fala de foto nenhuma — prova que se desmonta
 * na primeira leitura. Por isso a versão sai daqui pela finalidade e nunca do
 * formulário, que é entrada externa.
 */
export function versaoDoConsentimento(finalidade: string): string | null {
  return CONSENTIMENTOS_OPCIONAIS.find((c) => c.finalidade === finalidade)?.versao ?? null;
}

/** As finalidades que o titular decide sozinho — as três opcionais. */
export type FinalidadeOpcional = (typeof CONSENTIMENTOS_OPCIONAIS)[number]['finalidade'];

export function ehFinalidadeOpcional(valor: string): valor is FinalidadeOpcional {
  return CONSENTIMENTOS_OPCIONAIS.some((c) => c.finalidade === valor);
}
