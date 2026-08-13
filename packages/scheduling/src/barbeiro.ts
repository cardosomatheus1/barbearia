import { withTenant } from '@barbearia/db';
import {
  ehEspecialidade,
  resumoPublico,
  type Especialidade,
  type PerfilDoBarbeiro,
} from '@barbearia/core';

/**
 * A página pública do barbeiro (bloco 73, SPEC §5.2).
 *
 * > *"Perfil público do barbeiro (opcional, por profissional)"*
 * > ```
 * > João Silva                    ⭐ 4,92 · 1.842 atendimentos
 * > ```
 *
 * ## Só existe enquanto o perfil está ligado **e** a pessoa está na casa
 *
 * `public_profile`, `active` e `bookable_online`, os três. Um perfil no ar para
 * quem saiu da barbearia é o pior link que este produto pode ter: a página
 * continua indexada, o cliente clica em "Agendar com João" e descobre no balcão
 * que o João não trabalha mais ali.
 *
 * ## A nota é a **pública**, calculada pela mesma função da casa
 *
 * `resumoPublico` com o mesmo mínimo de avaliações e o mesmo corte das 48 horas
 * — *"5,0 de uma avaliação é ruído estatístico com cara de excelência"*. Duas
 * fontes para a mesma nota fariam a página do barbeiro e a da barbearia dizerem
 * números diferentes sobre a mesma pessoa, e quem compara os dois é quem está
 * decidindo com quem cortar.
 */

export interface PerfilPublicoDoBarbeiro extends PerfilDoBarbeiro {
  readonly professionalId: string;
  readonly locationId: string;
}

export async function perfilPublicoDoBarbeiro(
  tenantId: string,
  slugDoBarbeiro: string,
  agora: Date = new Date(),
): Promise<PerfilPublicoDoBarbeiro | null> {
  const desde48h = new Date(agora.getTime() - 48 * 3_600_000);

  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        location_id: string;
        name: string;
        public_slug: string;
        photo_url: string | null;
        bio: string | null;
        specialties: string[];
      }[]
    >`
      SELECT p.id, p.location_id, p.name, p.public_slug, p.photo_url, p.bio, p.specialties
        FROM professionals p
        /**
         * A unidade também precisa estar aberta.
         *
         * Fechar uma filial não desliga quem trabalhava nela, e sem esta junção
         * os barbeiros dela ficavam com página indexada e um botão "Agendar com
         * X" que funciona — exatamente o que esta função existe para impedir. E
         * ninguém notaria: getPublicProfile lista só a unidade mais antiga,
         * então eles nunca estiveram na página da casa. Achado da
         * /security-review deste bloco.
         */
        JOIN locations l ON l.id = p.location_id AND l.active
       WHERE p.public_slug = ${slugDoBarbeiro}
         AND p.public_profile AND p.active AND p.bookable_online
         AND p.kind IN ('professional', 'external')
    `;
    const barbeiro = linhas[0];
    if (!barbeiro) return null;

    /**
     * A nota e a contagem numa consulta só, e não uma por pergunta.
     *
     * São duas agregações sobre duas tabelas, e cada ida ao banco numa página
     * pública é latência que a meta de LCP paga.
     */
    const notas = await tx.$queryRaw<{ rating: number }[]>`
      SELECT r.rating FROM reviews r
       WHERE r.professional_id = ${barbeiro.id}::uuid
         AND (r.rating >= 4 OR r.created_at <= ${desde48h})
    `;
    const atendidos = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM appointments
       WHERE professional_id = ${barbeiro.id}::uuid AND status = 'completed'
    `;

    const resumo = resumoPublico(notas.map((n) => n.rating));

    return {
      professionalId: barbeiro.id,
      locationId: barbeiro.location_id,
      nome: barbeiro.name,
      slug: barbeiro.public_slug,
      fotoUrl: barbeiro.photo_url,
      bio: barbeiro.bio,
      /**
       * Filtra pelo conjunto fechado na **leitura**, e não só na escrita.
       *
       * A coluna é `text[]` e o banco não a limita; uma linha antiga, uma
       * importação ou um `UPDATE` feito à mão poriam um valor fora da lista, e
       * a tela procuraria um rótulo que não existe. `Record<Especialidade, T>`
       * com chave larga devolveria `undefined` e a frase sairia com um buraco.
       */
      especialidades: barbeiro.specialties.filter(ehEspecialidade) as Especialidade[],
      notaBps: resumo.media === null ? null : Math.round(resumo.media * 100),
      avaliacoes: resumo.total,
      atendimentos: Number(atendidos[0]?.n ?? 0),
    };
  });
}
