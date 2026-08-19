/**
 * O público que a tela de Retenção realmente mostra (bloco 108).
 *
 * ## O defeito
 *
 * Debaixo da lista de risco de abandono, a tela dizia: *"Para chamar todos de
 * uma vez, use **Em risco** em Campanhas."* Medido no piloto, ela apontava
 * quarenta e uma pessoas e aquele filtro alcançava **catorze** — vinte e duas
 * já eram `perdido`, cinco não tinham segmento nenhum, e do outro lado o
 * público `em_risco` trazia treze pessoas que não estavam na lista.
 *
 * As duas populações têm nomes parecidos e origens diferentes: `em_risco` sai
 * do ciclo individual de cada cliente (`segmentosDaBase`), e a lista de
 * Retenção sai do score de sete sinais (`churnDaBase`). É a §6 pergunta 6 —
 * duas telas classificando as mesmas pessoas com a mesma palavra "risco" e
 * discordando —, e quebra a convenção de que a contagem que a tela promete sai
 * do **mesmo filtro que o botão abre**.
 *
 * ## Por que um valor novo, e não trocar o que a frase aponta
 *
 * Mandar para `perdido` **e** `em_risco` cobriria quase todos e continuaria
 * sendo uma aproximação — sobrariam os cinco sem segmento, e o dono não teria
 * como saber que sobraram. E o filtro é congelado no público da campanha: a
 * pergunta que ele responde precisa ser a mesma que a tela fez.
 *
 * `ADD VALUE IF NOT EXISTS` é reaplicável, como toda migração depois da
 * baseline do livro-caixa.
 */
ALTER TYPE campaign_filter ADD VALUE IF NOT EXISTS 'risco_de_abandono';
