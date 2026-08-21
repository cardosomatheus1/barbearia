-- O atendimento concluído para de segurar a cadeira até o fim da reserva.
--
-- Um corte marcado das 18:15 às 19:35, concluído às 18:36 porque o cliente saiu
-- mais cedo, continuava ocupando a agenda por mais uma hora. O painel da fila
-- dizia "Ruan — livre agora" e o botão "Sentou", na mesma tela, respondia
-- "este profissional tem cliente marcado nesse horário": duas telas discordando
-- sobre o mesmo fato, na transição mais frequente do balcão. E o conserto que a
-- frase sugeria era impossível — `rescheduleAppointment` recusa `completed`.
--
-- Acontece toda vez que um corte termina antes da hora, que é o caso comum e
-- não a exceção. É a quarta vez que o padrão "não desperdiçar capacidade"
-- aparece neste produto, e a mais cara: cadeira vazia com gente na porta.
--
-- ## Encolher, nunca esticar
--
-- `LEAST(fim, GREATEST(inicio, concluido_em))`:
--
--   * concluído antes do fim  -> a janela encolhe até o instante real;
--   * concluído depois do fim -> nada muda. Esticar faria **concluir** um
--     atendimento que passou da hora ser recusado pela constraint, por causa do
--     horário do cliente seguinte — o balcão não conseguiria fechar a venda;
--   * concluído antes do início (relógio torto) -> janela vazia, que não
--     sobrepõe nada. É o que se quer: aquilo não ocupou tempo nenhum;
--   * ainda não concluído -> `COALESCE` devolve o fim da reserva, como antes.
--
-- ## Uma definição, não duas
--
-- A função existe para a constraint e o motor de disponibilidade dizerem a
-- **mesma** coisa. Escritas em dois lugares, elas divergiriam no primeiro
-- ajuste — e a divergência aqui é a agenda recusando o que a grade ofereceu, ou
-- oferecendo o que a gravação recusa. É a mesma razão do índice parcial da nota
-- fiscal dizer o mesmo que o filtro da aplicação.
--
-- `IMMUTABLE` porque uma constraint de exclusão exige: a função não lê relógio
-- nem fuso, só compara três instantes.
--
-- ## O custo de aplicar
--
-- `DROP` e `ADD CONSTRAINT` reconstroem o índice gist e tomam lock exclusivo em
-- `appointments`. Numa base grande isso é uma janela de manutenção; hoje a
-- maior tem alguns milhares de linhas.
--
-- Reaplicável, como toda migração depois da baseline do livro-caixa.

CREATE OR REPLACE FUNCTION janela_ocupada(
  inicio timestamptz,
  fim timestamptz,
  concluido_em timestamptz
) RETURNS tstzrange
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT tstzrange(inicio, LEAST(fim, GREATEST(inicio, COALESCE(concluido_em, fim))), '[)')
$$;

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_no_overlap;

ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    professional_id WITH =,
    janela_ocupada(starts_at, ends_at, completed_at) WITH &&
  )
  WHERE (status NOT IN ('cancelled_customer', 'cancelled_business', 'no_show', 'rescheduled'));
