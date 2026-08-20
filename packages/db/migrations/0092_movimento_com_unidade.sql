-- ---------------------------------------------------------------------------
-- `stock_movements.location_id` passa a ser obrigatoria (bloco 117)
--
-- A 0061 preencheu a coluna para toda barbearia de **uma** loja e deixou nula a
-- de quem tivesse duas, com o motivo escrito: "com duas, qual delas e palpite, e
-- um palpite aqui move estoque de lugar num relatorio fechado".
--
-- Isso era verdade enquanto o saldo era da rede — a linha sem loja entrava na
-- soma de todo mundo. A partir deste bloco o saldo e da loja, e uma linha sem
-- loja deixa de aparecer em qualquer uma: estoque que existe e some da tela,
-- que e pior do que atribuido ao lugar mais provavel.
--
-- Nenhuma barbearia da base tem duas lojas hoje — e e por isso que a varredura
-- de multiunidade achou treze defeitos latentes de uma vez. O resto e atribuido
-- a loja mais antiga, que e a mesma resposta que `primaryLocation` da e a mesma
-- que a pagina publica desenha.
--
-- ## Sem `SET NOT NULL`, e a guarda de migracao aditiva esta certa
--
-- `SET NOT NULL` numa tabela que ja existe quebra o rollback: a versao anterior
-- da aplicacao volta a escrever nulo e passa a falhar, entao "sobe a imagem
-- anterior" deixa de ser rollback. E operacao de duas fases em dois deploys, e
-- esta e a primeira.
--
-- O que impede o caminho novo de reabrir o buraco enquanto isso e o **tipo**:
-- `moverEstoque` passou a exigir `locationId: string`, e o compilador cobra o
-- caminho que esquecer — foi assim que a entrada, que nao preenchia a coluna
-- que a venda preenchia, apareceu.
-- ---------------------------------------------------------------------------

UPDATE stock_movements m
   SET location_id = mais_antiga.id
  FROM (
    SELECT DISTINCT ON (tenant_id) tenant_id, id
      FROM locations
     ORDER BY tenant_id, created_at
  ) AS mais_antiga
 WHERE m.location_id IS NULL
   AND m.tenant_id = mais_antiga.tenant_id;

COMMENT ON COLUMN stock_movements.location_id IS
  'A loja do movimento. Preenchida em todo caminho desde o bloco 117, em que o '
  'tipo passou a exigi-la; o NOT NULL e a segunda fase, num deploy proprio.';
