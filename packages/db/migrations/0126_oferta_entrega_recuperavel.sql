-- O hash continua autenticando o convite. A cifra só permite retomar sua entrega.
ALTER TABLE waitlist_offers ADD COLUMN delivery_token_cipher text;
CREATE FUNCTION limpar_token_de_entrega_da_oferta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'aberta' THEN NEW.delivery_token_cipher := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER waitlist_offers_limpar_token BEFORE INSERT OR UPDATE ON waitlist_offers
  FOR EACH ROW EXECUTE FUNCTION limpar_token_de_entrega_da_oferta();
