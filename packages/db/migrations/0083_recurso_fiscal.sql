-- ============================================================================
-- 0083 — a nota fiscal vira recurso ligado pela plataforma, e nasce desligada
--
-- Até aqui o fiscal estava no painel de toda barbearia desde o primeiro dia: a
-- tela no menu, a rota respondendo, o cartão na comanda. O que não existia era
-- **emissor contratado** — `FISCAL_MODO` é `nenhum`, e a tela dizia isso em
-- letras, que é a convenção do repositório para gatilho que ainda não funciona.
--
-- Aquela convenção continua certa para o que a barbearia liga. Esta decisão é
-- outra e é da plataforma: *a nota fiscal não está no ar ainda, e quem decide
-- quando ela entra somos nós, uma conta de cada vez*. Isso já tem mecanismo
-- neste código — `feature_flags` + `tenant_features`, do bloco 26 —, e é o
-- quarto recurso a usá-lo. Inventar um interruptor novo para o fiscal seria a
-- segunda maneira de responder "esta conta tem X?", e a primeira coisa que
-- diverge quando alguém acrescenta a quinta.
--
-- ## Por que `false`, e por que sem linha em `plan_features`
--
-- `default_enabled = false` é a regra que já está escrita: *regra que recusa
-- nasce desligada*. Aqui não há nem o que ligar — sem emissor, a rota de emitir
-- responde 503 —, então o padrão ligado produziria uma tela que só serve para
-- explicar por que ela não serve.
--
-- E não entra em `plan_features` de propósito: os outros três (`fila`,
-- `importacao`, `avisos`) são **conteúdo de plano** — é o que faz Starter e
-- Business custarem diferente. Fiscal não é isso hoje: é um recurso que ainda
-- não estreou. Uma linha de plano o ligaria para todo mundo que assina aquele
-- plano, que é exatamente o contrário do que se quer.
--
-- Com o catálogo em `false` e sem plano, `recursoLigado` só devolve verdadeiro
-- para quem tem linha em `tenant_features` — que é o que o toggle do Super
-- Admin escreve.
--
-- `DO NOTHING` e não `DO UPDATE`: semear padrão respeita quem já decidiu. Se
-- alguém já tiver ligado o fiscal para uma conta, reaplicar a migração não pode
-- desfazer aquela decisão.
-- ============================================================================

INSERT INTO feature_flags (code, name, description, default_enabled) VALUES
  ('fiscal', 'Nota fiscal',
   'Emissão de NFS-e pela comanda: cadastro de CNPJ, regime e alíquota, e a lista de notas do período. Depende de emissor contratado (FISCAL_MODO).',
   false)
ON CONFLICT (code) DO NOTHING;
