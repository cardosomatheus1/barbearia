-- A unidade de medida ganha `dose` e `aplicacao`.
--
-- A lista fechada do bloco 120 tinha três valores, copiados de um comentário da
-- migração 0047. A base de demonstração deste repositório — escrita por quem
-- estava pensando numa barbearia de verdade — já usava dois que não estavam
-- nela: o shampoo de lavatório sai por dose e o talco por aplicação. A CHECK
-- passou a recusá-los, e `semear-demo` parou de rodar no meio.
--
-- Fechar a lista continua certo: é ela que impede a importação de base de
-- inventar unidade que a ficha técnica não sabe ratear. Errado era o conteúdo.
--
-- Sem acento no valor guardado, com acento no rótulo da tela: 'un', 'ml' e 'g'
-- já eram assim.
--
-- Reaplicável, como toda migração depois da baseline do livro-caixa.

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_unit_conhecida;

ALTER TABLE products
  ADD CONSTRAINT products_unit_conhecida
  CHECK (unit IN ('un', 'ml', 'g', 'dose', 'aplicacao'));
