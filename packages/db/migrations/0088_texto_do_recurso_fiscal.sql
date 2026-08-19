-- O texto que a barbearia lê não nomeia variável de ambiente (bloco 104).
--
-- A descrição do recurso fiscal aparece em `/admin/plano`, na lista do que o
-- plano inclui, e terminava com *"Depende de emissor contratado
-- (FISCAL_MODO)"*. `FISCAL_MODO` é uma variável do servidor: para quem opera a
-- barbearia é ruído, e para quem não opera é informação de infraestrutura numa
-- tela de cliente.
--
-- O fato continua dito, porque ele importa — a emissão depende de a plataforma
-- ter emissor contratado, e sem isso o recurso aparece marcado e não funciona.
-- O que sai é o nome da variável.

UPDATE feature_flags
   SET description = 'Emissão de NFS-e pela comanda: cadastro de CNPJ, regime e alíquota, e a lista de notas do período. Depende de emissor fiscal contratado pela plataforma.'
 WHERE code = 'fiscal';
