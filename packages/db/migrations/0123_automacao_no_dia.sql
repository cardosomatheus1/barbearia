-- O domínio e a tela permitem 0 = no próprio dia nestes dois gatilhos.
-- A constraint anterior ainda exigia >0 e transformava um cadastro válido em 500.
ALTER TABLE automations DROP CONSTRAINT automations_limiar_positivo;
ALTER TABLE automations ADD CONSTRAINT automations_limiar_positivo CHECK (
  threshold IS NULL OR threshold > 0
  OR (threshold = 0 AND trigger IN ('aniversario', 'assinatura_vencendo'))
);
