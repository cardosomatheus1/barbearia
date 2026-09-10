-- O envio assistido é uma escolha da mensagem, independente da conexão da unidade.
ALTER TABLE whatsapp_templates DROP CONSTRAINT whatsapp_templates_transport_check;
ALTER TABLE whatsapp_templates ADD CONSTRAINT whatsapp_templates_transport_check
  CHECK (transport IN ('meta', 'baileys', 'manual'));


CREATE TABLE whatsapp_manual_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  location_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id),
  template_id uuid NOT NULL REFERENCES whatsapp_templates(id),
  campaign_target_id uuid UNIQUE REFERENCES campaign_targets(id),
  automation_send_id uuid UNIQUE REFERENCES automation_sends(id),
  template_body text NOT NULL,
  kind notification_kind NOT NULL,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'em_atendimento', 'enviado', 'descartado')),
  claimed_by uuid REFERENCES staff_users(id),
  claimed_at timestamptz,
  sent_by uuid REFERENCES staff_users(id),
  sent_at timestamptz,
  discarded_by uuid REFERENCES staff_users(id),
  discarded_at timestamptz,
  reason text CHECK (length(reason) <= 200),
  payload_cipher text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, tenant_id) REFERENCES locations(id, tenant_id),
  CHECK (num_nonnulls(campaign_target_id, automation_send_id) = 1),
  CHECK ((claimed_by IS NULL) = (claimed_at IS NULL)),
  CHECK ((sent_by IS NULL) = (sent_at IS NULL)),
  CHECK ((status = 'enviado') = (sent_at IS NOT NULL)),
  CHECK (status <> 'em_atendimento' OR (claimed_by IS NOT NULL AND payload_cipher IS NOT NULL)),
  CHECK (status <> 'descartado' OR discarded_at IS NOT NULL)
);
CREATE INDEX whatsapp_manual_queue_pending ON whatsapp_manual_queue(location_id, created_at, id)
  WHERE status IN ('pendente','em_atendimento');
CREATE INDEX whatsapp_manual_queue_customer ON whatsapp_manual_queue(customer_id);
ALTER TABLE whatsapp_manual_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_manual_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_manual_queue
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON whatsapp_manual_queue TO barbearia_app;

CREATE FUNCTION whatsapp_manual_anonimizar() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.anonymized_at IS NOT NULL AND OLD.anonymized_at IS NULL THEN
    UPDATE public.whatsapp_manual_queue SET payload_cipher = NULL,
      status = CASE WHEN status IN ('pendente','em_atendimento') THEN 'descartado' ELSE status END,
      discarded_at = CASE WHEN status IN ('pendente','em_atendimento') THEN now() ELSE discarded_at END,
      reason = 'cliente_anonimizado'
    WHERE customer_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_manual_anonimizar AFTER UPDATE OF anonymized_at ON customers
FOR EACH ROW EXECUTE FUNCTION whatsapp_manual_anonimizar();
REVOKE ALL ON FUNCTION whatsapp_manual_anonimizar() FROM PUBLIC;

-- A FK sozinha ignora RLS. A identidade e a finalidade são conferidas na origem.
CREATE FUNCTION whatsapp_manual_integridade() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.location_id, NEW.customer_id, NEW.template_id,
    NEW.campaign_target_id, NEW.automation_send_id, NEW.kind, NEW.template_body, NEW.created_at)
    IS DISTINCT FROM (OLD.tenant_id, OLD.location_id, OLD.customer_id, OLD.template_id,
    OLD.campaign_target_id, OLD.automation_send_id, OLD.kind, OLD.template_body, OLD.created_at)
  THEN RAISE EXCEPTION 'Identidade da mensagem manual e imutavel'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_templates w WHERE w.id = NEW.template_id
    AND w.tenant_id = NEW.tenant_id AND w.location_id = NEW.location_id AND w.transport = 'manual' AND w.kind = NEW.kind)
  THEN RAISE EXCEPTION 'Mensagem manual de outra unidade'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = NEW.customer_id AND c.tenant_id = NEW.tenant_id)
  THEN RAISE EXCEPTION 'Cliente de outra barbearia'; END IF;
  IF NEW.campaign_target_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM public.campaign_targets t JOIN public.campaigns c ON c.id = t.campaign_id
      WHERE t.id = NEW.campaign_target_id AND t.tenant_id = NEW.tenant_id AND t.customer_id = NEW.customer_id AND c.template_id = NEW.template_id)
  THEN RAISE EXCEPTION 'Alvo de campanha divergente'; END IF;
  IF NEW.automation_send_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM public.automation_sends s JOIN public.automations a ON a.id = s.automation_id
      WHERE s.id = NEW.automation_send_id AND s.tenant_id = NEW.tenant_id AND s.customer_id = NEW.customer_id
        -- Depois de criada, a fila preserva o texto mesmo se a automação for editada.
        AND (TG_OP <> 'INSERT' OR (a.template_id = NEW.template_id AND a.kind = NEW.kind)))
  THEN RAISE EXCEPTION 'Disparo de automacao divergente'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[NEW.claimed_by, NEW.sent_by, NEW.discarded_by]) ator
    WHERE ator IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.staff_users st WHERE st.id = ator AND st.tenant_id = NEW.tenant_id))
  THEN RAISE EXCEPTION 'Operador de outra barbearia'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_manual_integridade BEFORE INSERT OR UPDATE ON whatsapp_manual_queue
FOR EACH ROW EXECUTE FUNCTION whatsapp_manual_integridade();
REVOKE ALL ON FUNCTION whatsapp_manual_integridade() FROM PUBLIC;

ALTER TABLE campaigns ADD COLUMN manual_request_key uuid, ADD COLUMN manual_request_hash text;
ALTER TABLE automations ADD COLUMN manual_request_key uuid, ADD COLUMN manual_request_hash text;
CREATE UNIQUE INDEX campaigns_manual_request ON campaigns(tenant_id, created_by, manual_request_key) WHERE manual_request_key IS NOT NULL;
CREATE UNIQUE INDEX automations_manual_request ON automations(tenant_id, created_by, manual_request_key) WHERE manual_request_key IS NOT NULL;

-- Conversa aberta não expira silenciosamente: outro envio aguarda a decisão humana.
ALTER TABLE notification_send_intents ADD COLUMN manual_pending boolean NOT NULL DEFAULT false;
