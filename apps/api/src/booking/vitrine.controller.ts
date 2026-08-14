import { Controller, Get, Query } from '@nestjs/common';
import {
  rotuloDoProximoHorario,
  RESULTADOS_POR_BUSCA,
  type Disponibilidade,
  type FiltroDaBusca,
} from '@barbearia/core';
import { carimbarOrigem } from '@barbearia/identity';
import { buscarComHorario, cidadesNaVitrine } from '@barbearia/platform';
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
 * ## O "próximo horário" sai daqui, e o motor é o de sempre
 *
 * Desde o bloco 71 cada card traz a próxima vaga da casa — *"o elemento
 * principal do card, e o que diferencia de diretório"*. Quem a calcula é o mesmo
 * motor de `GET /availability`, rodado em lote: uma segunda noção de "horário
 * livre" seria a agenda vendida duas vezes.
 *
 * ## A projeção pública é escrita à mão, e é de propósito
 *
 * A busca interna carrega `tenantId`, `locationId` e o serviço do piso de preço,
 * porque o lote precisa deles para abrir a agenda de cada casa. Nada disso sai
 * na resposta: devolver o objeto inteiro faria todo campo novo da vitrine chegar
 * à internet sem ninguém ter decidido isso.
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
      disponivel: Disponibilidade;
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

    const agora = new Date();
    const busca = await buscarComHorario(filtro, query.disponivel, agora);

    return {
      // Projeção pública, campo a campo. Ver o cabeçalho: o que o lote precisou
      // saber para abrir a agenda não atravessa esta linha.
      resultados: busca.resultados.map((casa) => ({
        slug: casa.slug,
        nome: casa.nome,
        cidade: casa.cidade,
        estado: casa.estado,
        fotoUrl: casa.fotoUrl,
        precoDeCents: casa.precoDeCents,
        notaBps: casa.notaBps,
        avaliacoes: casa.avaliacoes,
        comodidades: casa.comodidades,
        temClube: casa.temClube,
        distanciaKm: casa.distanciaKm,
        /**
         * Card pago, dito em letras (bloco 75).
         *
         * Um resultado pago sem rótulo é publicidade disfarçada de
         * recomendação, e é a única coisa que faria a busca deste produto valer
         * menos que um diretório.
         */
        patrocinado: casa.patrocinado,
        /**
         * O carimbo de "veio pela busca" (bloco 72, SPEC §5.2).
         *
         * Emitido **aqui**, com o segredo do servidor, e conferido na borda do
         * agendamento. A página só o carrega: ela não assina nada, porque a
         * seta vai de `web` para `api` e trazer um pacote com acesso a banco
         * para dentro do servidor de páginas seria abri-la ao contrário.
         *
         * Ele não é segredo — sai numa rota pública, como o resto do card. O
         * que ele garante é que a origem gravada no agendamento foi emitida
         * pelo servidor para **esta** barbearia e dentro do prazo: sem isso, um
         * `curl` com a palavra "marketplace" no corpo fazia a casa dever
         * comissão por um cliente que ela mesma trouxe.
         */
        carimbo: carimbarOrigem(casa.slug, agora),
        /**
         * A frase vai pronta, e o instante vai junto.
         *
         * Quem decide se 17:40 é "hoje" é o fuso da **unidade** — o aparelho de
         * quem busca pode estar em qualquer lugar, e foi assim que o sistema
         * analisado errou a grade inteira (defeito D2).
         */
        proximoHorario: casa.proximoHorario
          ? {
              startsAt: casa.proximoHorario.startsAt,
              rotulo: rotuloDoProximoHorario(casa.proximoHorario),
            }
          : null,
      })),
      analisadas: busca.analisadas,
      truncada: busca.truncada,
      limite: RESULTADOS_POR_BUSCA,
    };
  }
}
