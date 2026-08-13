import { Controller, Get, Query } from '@nestjs/common';
import { RESULTADOS_POR_BUSCA, type FiltroDaBusca } from '@barbearia/core';
import { buscarNaVitrine, cidadesNaVitrine } from '@barbearia/platform';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { buscaNaVitrineSchema } from './vitrine.schemas.js';

/**
 * A busca do marketplace (bloco 70, SPEC §5.2).
 *
 * ## Pública e sem sessão, como o resto da superfície de descoberta
 *
 * Quem busca ainda não é cliente de ninguém — é o contrário: a busca existe para
 * que ele venha a ser. Exigir conta aqui é o mesmo que trancar a vitrine.
 *
 * ## E por isso ela não devolve nada que não seja público
 *
 * O que sai daqui é o que a página da barbearia já mostra a qualquer visitante:
 * nome, endereço, coordenada, foto, faixa de preço e nota. `marketplace_listings`
 * não tem coluna que alcance cliente, agenda ou dinheiro, e é essa ausência — não
 * uma política — que torna seguro ler sem tenant no contexto.
 *
 * ## O que ela ainda não responde
 *
 * *"Disponível hoje"* e *"disponível agora"* são filtros da SPEC §5.2 e não estão
 * aqui: os dois exigem rodar o motor de disponibilidade em lote sobre a lista de
 * resultados, que é o bloco 71 e a razão de ele existir separado. A tela mostra
 * os dois marcados como o que ainda não funciona, nunca escondidos — esconder
 * faria a SPEC parecer entregue.
 */
@Controller('v1/marketplace')
export class VitrineController {
  /**
   * As cidades que têm barbearia, com o centro de cada uma.
   *
   * É o que substitui "perto de mim" enquanto o produto não tiver componente de
   * cliente para ler a coordenada do aparelho — lacuna declarada. O centro sai
   * das próprias barbearias listadas, não de uma tabela de municípios que
   * alguém teria que manter.
   */
  @Get('cidades')
  async cidades() {
    return { cidades: await cidadesNaVitrine() };
  }

  @Get('busca')
  async buscar(
    @Query(new ZodValidationPipe(buscaNaVitrineSchema))
    query: {
      lat: number;
      lon: number;
      raioKm: number;
      ordem: FiltroDaBusca['ordem'];
      notaMinimaBps?: number;
      precoMaximoCents?: number;
      comodidades?: string[];
      clube?: boolean;
    },
  ) {
    const filtro: FiltroDaBusca = {
      de: { latitude: query.lat, longitude: query.lon },
      raioKm: query.raioKm,
      ordem: query.ordem,
      notaMinimaBps: query.notaMinimaBps ?? null,
      precoMaximoCents: query.precoMaximoCents ?? null,
      comodidades: query.comodidades ?? [],
      somenteComClube: query.clube === true,
    };

    const resultados = await buscarNaVitrine(filtro);
    return { resultados, limite: RESULTADOS_POR_BUSCA };
  }
}
