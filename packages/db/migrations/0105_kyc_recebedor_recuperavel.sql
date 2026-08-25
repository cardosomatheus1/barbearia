-- Cadastro de recebedor: lembrar a intenção que saiu para o adquirente.
--
-- A Idempotency-Key no HTTP protege duplo clique, mas não basta se o provider
-- criar o recebedor e o processo morrer antes de gravar `psp_recipient_id`.
-- Guardamos a chave **antes da rede**; uma nova tentativa, mesmo com uma chave
-- nova vinda de uma página recarregada, reutiliza a intenção antiga até o
-- adquirente devolver um desfecho persistível.

ALTER TABLE professionals
  ADD COLUMN psp_kyc_request_key varchar(128);

CREATE UNIQUE INDEX professionals_kyc_request_key_unique
  ON professionals (tenant_id, psp_kyc_request_key)
  WHERE psp_kyc_request_key IS NOT NULL;
