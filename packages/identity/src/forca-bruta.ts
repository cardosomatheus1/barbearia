import { semTenant } from '@barbearia/db';
import { esperaDeLogin, ESQUECER_APOS_SEGUNDOS } from '@barbearia/core';

/**
 * A escada de espera do login, ligada ao banco (bloco 33).
 *
 * A regra é pura e mora em `packages/core/src/login.ts`; aqui só se lê e se
 * escreve o contador. A separação é a de sempre — a decisão precisa ser testável
 * sem banco, e a contagem precisa de banco para valer entre processos.
 *
 * ## A chave é `(conta, origem)`, e a `/security-review` do bloco 33 é quem diz
 *
 * A primeira versão contava só por conta, e isso transformava a proteção em
 * arma: errar de propósito uma senha a cada meia hora, de qualquer endereço,
 * trancava o dono fora do próprio negócio para sempre. Com a origem na chave, o
 * atacante tranca a escada **dele**; o dono entra de outro endereço.
 *
 * ## Reserva antes de conferir a senha, numa transação só
 *
 * A mesma revisão apontou o segundo defeito, e ele era pior do que parece: a
 * conferência e o incremento eram duas transações com um scrypt no meio. Mil
 * requisições disparadas juntas liam `failures = 0` **todas**, e todas ganhavam
 * uma tentativa. A escada limitava rodadas sequenciais, não palpites — três
 * ordens de grandeza a mais do que o desenho prometia.
 *
 * Agora a tentativa é **reservada** antes: um `INSERT … ON CONFLICT DO UPDATE …
 * RETURNING` incrementa e devolve o valor novo, atomicamente. Quem chega junto
 * serializa na linha e cada um enxerga o degrau que o anterior criou. O acerto
 * zera depois.
 *
 * ## `semTenant`, e por quê
 *
 * O login acontece **antes** de existir tenant no contexto: é ele que descobre
 * de que barbearia é a conta. `login_attempts` tem política `USING (true)` pelo
 * mesmo motivo de `staff_directory`, e não guarda nada além de um HMAC, um
 * endereço, um contador e uma data.
 */

export class BloqueioDeLogin extends Error {
  constructor(readonly esperarSegundos: number) {
    super('Muitas tentativas deste aparelho. Espere antes de tentar de novo.');
    this.name = 'BloqueioDeLogin';
  }
}

/**
 * Reserva uma tentativa, e levanta se esta origem ainda está de castigo.
 *
 * Chamada **antes** de derivar a senha, e a ordem é a proteção: derivar
 * primeiro gastaria o scrypt de propósito em cima de quem já está bloqueado,
 * que é exatamente o custo que um atacante quer impor ao servidor.
 *
 * O incremento acontece mesmo no caminho que vai dar certo — `limparFalhas`
 * desfaz logo em seguida. Contar só o erro exigiria ler agora e escrever
 * depois, que é a janela que esta função existe para fechar.
 */
export async function reservarTentativaDeLogin(
  emailKey: string,
  ip: string | null,
  agora = new Date(),
): Promise<void> {
  const esquecer = new Date(agora.getTime() - ESQUECER_APOS_SEGUNDOS * 1000);

  const linhas = await semTenant(async (tx) =>
    tx.$queryRaw<{ failures: number; last_failure_at: Date | null }[]>`
      INSERT INTO login_attempts (email_key, ip, failures, last_failure_at, updated_at)
      VALUES (${emailKey}, ${ip}::inet, 1, ${agora}, ${agora})
      ON CONFLICT (email_key, COALESCE(ip, '::'::inet)) DO UPDATE
        SET failures = CASE
              -- Erro velho demais nao conta: quem errou duas vezes ha um ano
              -- nao deve cair na escada no primeiro engano de hoje. E a mesma
              -- regra de contarFalha, aplicada onde o valor atual esta.
              WHEN login_attempts.last_failure_at IS NULL
                OR login_attempts.last_failure_at <= ${esquecer} THEN 1
              ELSE login_attempts.failures + 1
            END,
            last_failure_at = ${agora},
            updated_at = ${agora}
      RETURNING failures, last_failure_at
    `,
  );

  const linha = linhas[0];
  if (!linha) return;

  /**
   * A espera é calculada sobre a contagem **anterior**.
   *
   * `failures` já inclui a tentativa que está sendo feita agora. Cobrar a
   * espera sobre ela puniria o sexto erro com o degrau do sétimo, e — pior — o
   * primeiro acesso legítimo de alguém que errou cinco vezes ontem esbarraria
   * numa espera que ele ainda não tinha conquistado.
   */
  const espera = esperaDeLogin(
    { falhas: linha.failures - 1, ultimaFalhaEm: linha.last_failure_at },
    agora,
  );
  if (espera > 0) throw new BloqueioDeLogin(espera);
}

/**
 * Zera a contagem depois de um acerto.
 *
 * Zerar e não apagar: a linha custa nada e o `updated_at` responde "quando esta
 * conta entrou pela última vez depois de ter errado", que é o que se pergunta
 * quando alguém desconfia de acesso indevido.
 *
 * Zera **todas** as origens daquela conta, e é deliberado: quem provou saber a
 * senha não deveria continuar de castigo num aparelho que ele também usa.
 */
export async function limparFalhasDeLogin(emailKey: string): Promise<void> {
  await semTenant(async (tx) => {
    await tx.$executeRaw`
      UPDATE login_attempts
         SET failures = 0, last_failure_at = NULL, updated_at = now()
       WHERE email_key = ${emailKey} AND failures > 0
    `;
  });
}
