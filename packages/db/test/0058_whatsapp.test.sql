-- ============================================================================
-- Invariantes do WhatsApp oficial (bloco 55).
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('58585858-0000-0000-0000-000000000001', 'Domari'),
  ('58585858-0000-0000-0000-000000000002', 'Vizinha');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('58585858-1111-0000-0000-000000000001',
   '58585858-0000-0000-0000-000000000001', 'Matriz', 'America/Bahia'),
  ('58585858-1111-0000-0000-000000000002',
   '58585858-0000-0000-0000-000000000002', 'Deles', 'America/Bahia');

-- ----------------------------------------------------------------------------
-- 1 — o token de acesso não tem onde morar em claro
--
-- Varredura de catálogo, como a do certificado fiscal no bloco 53 e a do dado
-- bancário no bloco 50. Coluna que não existe não é preenchida por engano — e o
-- jeito de uma credencial acabar em claro no banco é alguém achar que "só por
-- enquanto" resolve. O token do WhatsApp manda mensagem em nome da barbearia
-- para a base inteira de clientes dela.
-- ----------------------------------------------------------------------------
DO $$
DECLARE suspeitas text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO suspeitas
    FROM information_schema.columns
   WHERE table_name = 'whatsapp_settings'
     AND column_name ~ 'token|secret|senha|password|key'
     AND column_name NOT LIKE '%_cipher';

  IF suspeitas IS NOT NULL THEN
    RAISE EXCEPTION 'o cadastro do WhatsApp ganhou coluna de credencial em claro: %', suspeitas;
  END IF;
  RAISE NOTICE 'OK 1 — nenhuma credencial em claro no cadastro do WhatsApp';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — ativo exige os três: sem qualquer um deles não há como mandar nada
--
-- Um cadastro `ativo` pela metade é pior que `nao_configurado`: o motor tentaria
-- mandar, falharia em toda mensagem, e o dono leria "WhatsApp: ativo" na tela.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO whatsapp_settings (location_id, tenant_id, status, phone_number_id)
    VALUES ('58585858-1111-0000-0000-000000000001',
            '58585858-0000-0000-0000-000000000001', 'ativo', '1234');
    RAISE EXCEPTION 'cadastro ativo sem token foi aceito';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2a — ativo sem os três é recusado';
  END;

  INSERT INTO whatsapp_settings
    (location_id, tenant_id, status, phone_number_id, waba_id, access_token_cipher)
  VALUES ('58585858-1111-0000-0000-000000000001',
          '58585858-0000-0000-0000-000000000001', 'ativo', '1234', '5678', 'nonce.tag.dados');
  RAISE NOTICE 'OK 2b — ativo com os três é aceito';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — suspenso guarda o motivo, e continua com os ids
--
-- Implicação, não equivalência: a conta suspensa é a que precisa dizer por quê,
-- e é a que precisa manter os ids para poder ser reativada sem recadastro.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_ids text;
BEGIN
  BEGIN
    UPDATE whatsapp_settings SET status = 'suspenso'
     WHERE location_id = '58585858-1111-0000-0000-000000000001';
    RAISE EXCEPTION 'suspensão sem motivo foi aceita';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3a — suspender exige motivo escrito';
  END;

  UPDATE whatsapp_settings
     SET status = 'suspenso', status_reason = 'qualidade do número caiu para baixa'
   WHERE location_id = '58585858-1111-0000-0000-000000000001';

  SELECT phone_number_id INTO v_ids FROM whatsapp_settings
   WHERE location_id = '58585858-1111-0000-0000-000000000001';
  IF v_ids IS NULL THEN
    RAISE EXCEPTION 'a suspensão apagou os ids da Meta';
  END IF;
  RAISE NOTICE 'OK 3b — suspenso guarda motivo e ids';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — um template aprovado por tipo, e o histórico de recusa fica
--
-- Dois aprovados para o mesmo aviso fariam a escolha de qual mandar ser
-- arbitrária, e mudar entre duas leituras. Já o rejeitado se acumula de
-- propósito: é ele que explica ao dono por que a mensagem não sai.
-- ----------------------------------------------------------------------------
INSERT INTO whatsapp_templates
  (id, tenant_id, location_id, kind, name, status, body)
VALUES ('58585858-2222-0000-0000-000000000001',
        '58585858-0000-0000-0000-000000000001',
        '58585858-1111-0000-0000-000000000001',
        'lembrete_24h', 'lembrete_24h_v1', 'aprovado', 'Olá {{1}}, seu corte é amanhã às {{2}}.');

DO $$
BEGIN
  BEGIN
    INSERT INTO whatsapp_templates
      (tenant_id, location_id, kind, name, status, body)
    VALUES ('58585858-0000-0000-0000-000000000001',
            '58585858-1111-0000-0000-000000000001',
            'lembrete_24h', 'lembrete_24h_v2', 'aprovado', 'outro texto');
    RAISE EXCEPTION 'dois templates aprovados para o mesmo aviso foram aceitos';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 4a — um aprovado por tipo e idioma';
  END;

  -- O rejeitado entra ao lado, e é o histórico que explica.
  INSERT INTO whatsapp_templates
    (tenant_id, location_id, kind, name, status, body, rejection_reason)
  VALUES ('58585858-0000-0000-0000-000000000001',
          '58585858-1111-0000-0000-000000000001',
          'lembrete_24h', 'lembrete_24h_v2', 'rejeitado', 'outro texto',
          'conteúdo promocional em template utilitário');
  RAISE NOTICE 'OK 4b — o rejeitado se acumula ao lado do aprovado';
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO whatsapp_templates
      (tenant_id, location_id, kind, name, status, body)
    VALUES ('58585858-0000-0000-0000-000000000001',
            '58585858-1111-0000-0000-000000000001',
            'confirmacao', 'Confirmação V1', 'rascunho', 'texto');
    RAISE EXCEPTION 'nome fora do formato da Meta foi aceito';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4c — o nome segue o formato que a Meta exige';
  END;

  BEGIN
    INSERT INTO whatsapp_templates
      (tenant_id, location_id, kind, name, status, body)
    VALUES ('58585858-0000-0000-0000-000000000001',
            '58585858-1111-0000-0000-000000000001',
            'confirmacao', 'confirmacao_v1', 'rejeitado', 'texto');
    RAISE EXCEPTION 'template rejeitado sem motivo foi aceito';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4d — recusa da Meta exige motivo gravado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — a reentrega da Meta não duplica nada
--
-- Reentregar webhook é comportamento normal dela. Sem a unicidade por id de
-- mensagem, a mesma confirmação de leitura contaria duas vezes, e o mesmo toque
-- em "cancelar" cancelaria um horário que já tinha sido remarcado por cima.
-- ----------------------------------------------------------------------------
INSERT INTO whatsapp_messages (tenant_id, wamid)
VALUES ('58585858-0000-0000-0000-000000000001', 'wamid.HBgM1');

INSERT INTO whatsapp_inbound (tenant_id, wamid, from_phone, payload)
VALUES ('58585858-0000-0000-0000-000000000001', 'wamid.HBgM2', '+5571988887777', 'cancelar');

DO $$
BEGIN
  BEGIN
    INSERT INTO whatsapp_messages (tenant_id, wamid)
    VALUES ('58585858-0000-0000-0000-000000000001', 'wamid.HBgM1');
    RAISE EXCEPTION 'a mesma mensagem foi gravada duas vezes';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 5a — mensagem é única por id da Meta';
  END;

  BEGIN
    INSERT INTO whatsapp_inbound (tenant_id, wamid, from_phone, payload)
    VALUES ('58585858-0000-0000-0000-000000000001', 'wamid.HBgM2', '+5571988887777', 'cancelar');
    RAISE EXCEPTION 'a mesma resposta foi gravada duas vezes';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 5b — resposta é única por id da Meta';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — o id da Meta é único **entre barbearias**, não dentro de cada uma
--
-- É o contrário de quase tudo neste schema, e é de propósito: o `wamid` é dela,
-- não nosso, e o webhook chega **antes** de sabermos de quem é. Um índice por
-- tenant deixaria a segunda barbearia gravar o mesmo id, e a busca pelo id na
-- hora de tratar acharia duas linhas.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO whatsapp_messages (tenant_id, wamid)
    VALUES ('58585858-0000-0000-0000-000000000002', 'wamid.HBgM1');
    RAISE EXCEPTION 'duas barbearias gravaram o mesmo id de mensagem';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 6 — o id da Meta é único no produto inteiro';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 7 — falha da Meta exige motivo
--
-- "Não entregou" sem motivo transforma toda pergunta do dono numa investigação —
-- é a mesma decisão de `notifications.reason`, do bloco 20.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE whatsapp_messages SET status = 'falhou' WHERE wamid = 'wamid.HBgM1';
    RAISE EXCEPTION 'falha sem motivo foi aceita';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 7 — falha da Meta exige motivo gravado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 8 — RLS forçada nas quatro tabelas novas
--
-- A afirmação é sobre o **catálogo**, e não uma leitura sob outro tenant: esta
-- suíte roda como superusuário, que ignora row security por completo. Um teste
-- que tentasse ler enxergaria tudo e passaria a acusar o que está certo. Quem
-- prova o isolamento de verdade é `packages/db/src/client.test.ts`, que conecta
-- pelo role restrito.
-- ----------------------------------------------------------------------------
DO $$
DECLARE faltando text;
BEGIN
  SELECT string_agg(relname, ', ') INTO faltando
    FROM pg_class
   WHERE relname IN ('whatsapp_settings', 'whatsapp_templates',
                     'whatsapp_messages', 'whatsapp_inbound')
     AND NOT (relrowsecurity AND relforcerowsecurity);

  IF faltando IS NOT NULL THEN
    RAISE EXCEPTION 'sem RLS forçada: %', faltando;
  END IF;
  RAISE NOTICE 'OK 8 — RLS forçada nas tabelas do WhatsApp';
END $$;

-- ----------------------------------------------------------------------------
-- 9 — a unidade com WhatsApp cadastrado não se apaga em cascata
--
-- `ON DELETE RESTRICT` e não `CASCADE`: apagar a unidade levaria junto o
-- cadastro do número, e com ele o histórico de mensagens que explica por que a
-- Meta suspendeu a conta. Ação referencial roda com os direitos do dono e não
-- passa por `REVOKE` — é a lição dos blocos 51 e 53.
-- ----------------------------------------------------------------------------
DO $$
DECLARE cascatas text;
BEGIN
  SELECT string_agg(c.conname, ', ') INTO cascatas
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_class f ON f.oid = c.confrelid
   WHERE t.relname IN ('whatsapp_settings', 'whatsapp_templates')
     AND c.contype = 'f'
     AND c.confdeltype = 'c'
     -- `tenant_id` é a única cascata legítima: sem a barbearia não há nada.
     AND f.relname <> 'tenants';

  IF cascatas IS NOT NULL THEN
    RAISE EXCEPTION 'o WhatsApp ganhou chave em cascata: %', cascatas;
  END IF;
  RAISE NOTICE 'OK 9 — nada do WhatsApp some em cascata';
END $$;

ROLLBACK;
