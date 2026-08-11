-- ============================================================================
-- Invariantes do recado do cliente (bloco 40).
--
-- O que se prova aqui é sobretudo **o que não dá para fazer**: apagar uma
-- reclamação. O limite ético da SPEC §4.10 vira promessa de tela se depender de
-- alguém não escrever um `DELETE` — aqui ele é a ausência do privilégio.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('40404040-0000-0000-0000-000000000001', 'Domari'),
  ('40404040-0000-0000-0000-000000000002', 'Vizinha');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('40404040-1111-0000-0000-000000000001',
   '40404040-0000-0000-0000-000000000001', 'Centro', 'America/Bahia');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('40404040-3333-0000-0000-000000000001',
   '40404040-0000-0000-0000-000000000001', 'Carlos', '+5571988887777');

-- ----------------------------------------------------------------------------
-- 1 — o recado anônimo existe, e é o mais honesto que há
--
-- Quem desistiu da fila e foi embora não tem cadastro, não tem agendamento e é
-- justamente quem mais tem o que contar. Exigir qualquer um dos dois perderia
-- essa pessoa.
-- ----------------------------------------------------------------------------
INSERT INTO feedbacks (id, tenant_id, location_id, kind, body)
VALUES ('40404040-5555-0000-0000-000000000001',
        '40404040-0000-0000-0000-000000000001',
        '40404040-1111-0000-0000-000000000001',
        'reclamacao', 'Esperei quarenta minutos e ninguem me avisou nada.');

DO $$ BEGIN RAISE NOTICE 'OK 1 — recado sem cliente e sem atendimento é aceito'; END $$;

-- ----------------------------------------------------------------------------
-- 2 — texto vazio, curto ou sem fim não entra
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO feedbacks (tenant_id, location_id, kind, body)
    VALUES ('40404040-0000-0000-0000-000000000001',
            '40404040-1111-0000-0000-000000000001', 'sugestao', '     ');
    RAISE EXCEPTION 'aceitou recado em branco';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2a — recado em branco recusado';
  END;

  BEGIN
    INSERT INTO feedbacks (tenant_id, location_id, kind, body)
    VALUES ('40404040-0000-0000-0000-000000000001',
            '40404040-1111-0000-0000-000000000001', 'sugestao', repeat('a', 2001));
    RAISE EXCEPTION 'aceitou recado sem teto';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2b — recado acima do teto recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — "respondido" sem resposta escrita é um estado mentindo
--
-- A fila é lida por quem decide o que fazer em seguida. Um recado marcado como
-- respondido e sem texto faz a próxima pessoa não olhar de novo.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE feedbacks SET status = 'respondido'
     WHERE id = '40404040-5555-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou respondido sem resposta';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3a — respondido sem resposta recusado';
  END;

  BEGIN
    UPDATE feedbacks SET status = 'encerrado'
     WHERE id = '40404040-5555-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou encerrado sem hora';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3b — encerrado sem hora recusado';
  END;

  UPDATE feedbacks
     SET status = 'respondido', answer = 'Desculpe. Ja ajustamos a escala de sabado.',
         answered_at = now()
   WHERE id = '40404040-5555-0000-0000-000000000001';
  RAISE NOTICE 'OK 3c — respondido com resposta e hora aceito';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — a aplicação não consegue apagar reclamação
--
-- É o limite ético da SPEC §4.10 escrito onde não depende de ninguém lembrar.
-- Encerrar é um estado; o texto continua, e a contagem de reclamações do
-- trimestre continua verdadeira.
-- ----------------------------------------------------------------------------
SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '40404040-0000-0000-0000-000000000001', true);

DO $$
BEGIN
  BEGIN
    DELETE FROM feedbacks WHERE id = '40404040-5555-0000-0000-000000000001';
    RAISE EXCEPTION 'a aplicação apagou uma reclamação';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 4 — a aplicação não tem DELETE em feedbacks';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — a barbearia vizinha não lê nem escreve estes recados
-- ----------------------------------------------------------------------------
SELECT set_config('app.tenant_id', '40404040-0000-0000-0000-000000000002', true);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM feedbacks;
  IF n <> 0 THEN
    RAISE EXCEPTION 'a vizinha enxerga % recados alheios', n;
  END IF;
  RAISE NOTICE 'OK 5a — a vizinha não lê os recados desta barbearia';

  BEGIN
    INSERT INTO feedbacks (tenant_id, location_id, kind, body)
    VALUES ('40404040-0000-0000-0000-000000000001',
            '40404040-1111-0000-0000-000000000001',
            'elogio', 'Recado plantado pela barbearia vizinha.');
    RAISE EXCEPTION 'a vizinha escreveu recado na barbearia alheia';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 5b — WITH CHECK impede escrever em nome de outra barbearia';
  END;
END $$;

RESET ROLE;

-- ----------------------------------------------------------------------------
-- 6 — anonimizar solta o recado e não o apaga
--
-- As duas coisas são verdadeiras ao mesmo tempo: a pessoa sai, e a barbearia
-- continua sabendo que a cadeira do fundo está bamba.
-- ----------------------------------------------------------------------------
INSERT INTO feedbacks (id, tenant_id, location_id, customer_id, kind, body)
VALUES ('40404040-5555-0000-0000-000000000002',
        '40404040-0000-0000-0000-000000000001',
        '40404040-1111-0000-0000-000000000001',
        '40404040-3333-0000-0000-000000000001',
        'reclamacao', 'A cadeira do fundo esta bamba faz meses.');

SELECT set_config('app.tenant_id', '40404040-0000-0000-0000-000000000001', true);
SELECT anonimizar_cliente('40404040-3333-0000-0000-000000000001', 'pedido do titular');

DO $$
DECLARE v_dono uuid; v_texto text;
BEGIN
  SELECT customer_id, body INTO v_dono, v_texto
    FROM feedbacks WHERE id = '40404040-5555-0000-0000-000000000002';

  IF v_dono IS NOT NULL THEN
    RAISE EXCEPTION 'o recado continuou apontando para o cliente anonimizado';
  END IF;
  IF v_texto IS NULL THEN
    RAISE EXCEPTION 'a anonimização apagou a melhoria junto com a pessoa';
  END IF;
  RAISE NOTICE 'OK 6 — anonimizar desata o vínculo e preserva o texto';
END $$;

-- ----------------------------------------------------------------------------
-- 7 — as duas permissões novas são reconhecidas pelo banco
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO role_permissions (tenant_id, role, permission)
  VALUES ('40404040-0000-0000-0000-000000000001', 'manager', 'feedback.view'),
         ('40404040-0000-0000-0000-000000000001', 'manager', 'feedback.manage')
  ON CONFLICT DO NOTHING;
  RAISE NOTICE 'OK 7a — feedback.view e feedback.manage são permissões válidas';

  BEGIN
    INSERT INTO role_permissions (tenant_id, role, permission)
    VALUES ('40404040-0000-0000-0000-000000000001', 'manager', 'feedback.delete');
    RAISE EXCEPTION 'aceitou uma permissão de apagar recado';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 7b — não existe permissão de apagar recado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 8 — o índice da triagem existe
--
-- A fila é aberta a cada abertura da tela do balcão, e ela ignora o que já foi
-- encerrado. Índice parcial pelo mesmo motivo do resto do produto.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'feedbacks' AND indexname = 'feedbacks_triagem_idx'
  ) THEN
    RAISE EXCEPTION 'falta o índice da fila de triagem';
  END IF;
  RAISE NOTICE 'OK 8 — o índice parcial da triagem existe';
END $$;

-- ----------------------------------------------------------------------------
-- 9 — o aviso de resposta entrou no vocabulário de notificação
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'notification_kind' AND e.enumlabel = 'resposta_recado'
  ) THEN
    RAISE EXCEPTION 'falta o tipo de aviso da resposta ao recado';
  END IF;
  RAISE NOTICE 'OK 9 — resposta_recado existe como tipo de aviso';
END $$;

ROLLBACK;
