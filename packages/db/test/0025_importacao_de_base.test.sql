-- ============================================================================
-- Invariantes da importação de base.
--
-- O que se prova aqui é o que a SPEC §5.8 exige e o código sozinho não garante:
-- que o mesmo arquivo não entra duas vezes, que o estado e o carimbo não podem
-- divergir, e que apagar o registro da importação não leva junto os clientes.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('25252525-0000-0000-0000-000000000001', 'Domari'),
  ('25252525-0000-0000-0000-000000000002', 'Rival');

INSERT INTO imports (id, tenant_id, file_name, file_sha256, separator, summary)
VALUES ('a5252525-0000-0000-0000-000000000001', '25252525-0000-0000-0000-000000000001',
        'clientes.csv', repeat('a', 64), ';', '{"novo": 3}');

-- 1 — o mesmo arquivo não entra duas vezes na mesma barbearia
DO $$
BEGIN
  BEGIN
    INSERT INTO imports (tenant_id, file_name, file_sha256, separator)
    VALUES ('25252525-0000-0000-0000-000000000001', 'clientes (1).csv', repeat('a', 64), ';');
    RAISE EXCEPTION 'o mesmo arquivo entrou duas vezes';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 1 — reimportar o mesmo arquivo é recusado pelo banco';
  END;
END $$;

-- 2 — mas o mesmo arquivo em outra barbearia é outra importação
INSERT INTO imports (tenant_id, file_name, file_sha256, separator)
VALUES ('25252525-0000-0000-0000-000000000002', 'clientes.csv', repeat('a', 64), ';');
DO $$
BEGIN
  RAISE NOTICE 'OK 2 — duas barbearias importam o mesmo arquivo sem colidir';
END $$;

-- 3 — estado e carimbo não divergem
DO $$
BEGIN
  BEGIN
    UPDATE imports SET status = 'applied'
     WHERE id = 'a5252525-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'aplicou sem carimbar quando';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3 — não dá para marcar aplicada sem dizer quando';
  END;
END $$;

DO $$
BEGIN
  BEGIN
    UPDATE imports SET status = 'reverted', reverted_at = now()
     WHERE id = 'a5252525-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'desfez uma importação que nunca foi aplicada';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4 — não dá para desfazer o que nunca foi aplicado';
  END;
END $$;

UPDATE imports SET status = 'applied', applied_at = now()
 WHERE id = 'a5252525-0000-0000-0000-000000000001';

-- 5 — desfeita, a trava de idempotência solta
UPDATE imports SET status = 'reverted', reverted_at = now()
 WHERE id = 'a5252525-0000-0000-0000-000000000001';
INSERT INTO imports (tenant_id, file_name, file_sha256, separator)
VALUES ('25252525-0000-0000-0000-000000000001', 'clientes.csv', repeat('a', 64), ';');
DO $$
BEGIN
  RAISE NOTICE 'OK 5 — depois de desfeita, o mesmo arquivo pode ser importado de novo';
END $$;

-- 6 — hash malformado não entra
DO $$
BEGIN
  BEGIN
    INSERT INTO imports (tenant_id, file_name, file_sha256, separator)
    VALUES ('25252525-0000-0000-0000-000000000001', 'x.csv', 'NAO-E-UM-HASH', ';');
    RAISE EXCEPTION 'aceitou hash que não é hash';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6 — file_sha256 tem que ser um sha256 de verdade';
  END;
END $$;

-- 7 — apagar a importação não apaga o cliente que ela criou
INSERT INTO imports (id, tenant_id, file_name, file_sha256, separator, status, applied_at)
VALUES ('a5252525-0000-0000-0000-000000000009', '25252525-0000-0000-0000-000000000001',
        'outra.csv', repeat('b', 64), ';', 'applied', now());

INSERT INTO customers (id, tenant_id, name, phone_e164, import_id, birth_date)
VALUES ('c5252525-0000-0000-0000-000000000001', '25252525-0000-0000-0000-000000000001',
        'Zé da Silva', '+5571988887777', 'a5252525-0000-0000-0000-000000000009', DATE '1985-09-07');

DELETE FROM imports WHERE id = 'a5252525-0000-0000-0000-000000000009';

DO $$
DECLARE sobrou int;
BEGIN
  SELECT count(*) INTO sobrou FROM customers
   WHERE id = 'c5252525-0000-0000-0000-000000000001' AND import_id IS NULL;
  IF sobrou <> 1 THEN
    RAISE EXCEPTION 'apagar a importação levou o cliente junto';
  END IF;
  RAISE NOTICE 'OK 7 — cliente sobrevive ao sumiço do registro da importação';
END $$;

-- 8 — nascimento implausível não entra
DO $$
BEGIN
  BEGIN
    INSERT INTO customers (tenant_id, name, phone_e164, birth_date)
    VALUES ('25252525-0000-0000-0000-000000000001', 'Matusalém', '+5571966665555',
            DATE '1830-01-01');
    RAISE EXCEPTION 'aceitou nascimento de 1830';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 8 — data de nascimento anterior a 1900 é recusada';
  END;
END $$;

-- 9 — aplicar sem limpar a cópia dos dados pessoais é recusado
INSERT INTO imports (id, tenant_id, file_name, file_sha256, separator, payload)
VALUES ('a5252525-0000-0000-0000-000000000010', '25252525-0000-0000-0000-000000000001',
        'com-payload.csv', repeat('c', 64), ';', '[{"nome":"Zé"}]');

DO $$
BEGIN
  BEGIN
    UPDATE imports SET status = 'applied', applied_at = now()
     WHERE id = 'a5252525-0000-0000-0000-000000000010';
    RAISE EXCEPTION 'aplicou mantendo a cópia dos dados pessoais';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 9 — importação aplicada não guarda mais a cópia do arquivo';
  END;
END $$;

UPDATE imports SET status = 'applied', applied_at = now(), payload = NULL
 WHERE id = 'a5252525-0000-0000-0000-000000000010';

-- 10 — a importação de uma barbearia não é vista pela outra
SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '25252525-0000-0000-0000-000000000002', true);
DO $$
DECLARE visiveis int;
BEGIN
  SELECT count(*) INTO visiveis FROM imports;
  IF visiveis <> 1 THEN
    RAISE EXCEPTION 'a rival enxergou % importações em vez de 1', visiveis;
  END IF;
  RAISE NOTICE 'OK 10 — RLS separa a importação de cada barbearia';
END $$;

ROLLBACK;
