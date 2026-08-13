-- ============================================================================
-- 0068 — o serviço que o card anuncia (bloco 71, SPEC §5.2)
--
-- > ```
-- > 1,2 km · Corte a partir de R$ 55,00
-- > Próximo horário: 17:40                       [ Agendar ]
-- > ```
--
-- As duas linhas do card falam do **mesmo serviço**, e é isso que esta coluna
-- garante. Sem ela o lote teria que escolher um serviço por conta própria — e
-- escolher errado faria o card dizer "a partir de R$ 55,00" ao lado de um
-- horário que só existe para a barba de R$ 35.
--
-- ## Por que a coluna, e não uma segunda consulta no lote
--
-- O piso de preço sai de um predicado com cinco condições — serviço ativo e
-- vendável online, com profissional ativo, vendável online, do tipo certo e
-- desta unidade. É o mesmo predicado de `getPublicProfile`, e a
-- `/security-review` do bloco 70 achou justamente a versão em que ele estava
-- escrito de dois jeitos: a vitrine anunciava um "corte funcionário" de R$ 10
-- que a página pública não oferece.
--
-- Repeti-lo no lote seria a terceira cópia. A coluna é escrita pela **mesma
-- consulta** que calcula o preço, então as duas não têm como divergir.
--
-- ## Nula é resposta, não ausência de dado
--
-- Barbearia sem nada vendável online não tem preço de entrada e não tem horário
-- para anunciar: ela aparece na busca com o card mudo, que é a verdade. A linha
-- escrita antes desta migração também nasce nula e se conserta na primeira
-- atualização da vitrine — evento de publicação, edição do cadastro ou a
-- varredura diária, o que vier primeiro.
-- ============================================================================

ALTER TABLE marketplace_listings
  ADD COLUMN price_from_service_id uuid REFERENCES services(id) ON DELETE SET NULL;

COMMENT ON COLUMN marketplace_listings.price_from_service_id IS
  'O serviço que deu price_from_cents (bloco 71, SPEC §5.2). É ele que o lote '
  'consulta para o "próximo horário", para preço e horário do card falarem do '
  'mesmo serviço. ON DELETE SET NULL: o card fica mudo até a próxima varredura, '
  'em vez de apontar para um serviço que não existe mais.';
