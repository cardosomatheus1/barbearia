import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '@barbearia/db';
import { cobrarComReserva } from './cobranca-reserva.js';
import { aplicarRegua, cancelarFatura, pagarFatura, percorrerFaturasEmCobranca } from './cobranca.js';
import { conciliarPendentes } from './conciliacao.js';
import { FakePspProvider, type PedidoDeCobranca } from './psp.js';

const T='12500000-0000-0000-0000-000000000001';
const F='12500000-0000-0000-0000-000000000002';
const A='12500000-0000-0000-0000-000000000003';
const R='12500000-0000-0000-0000-000000000004';
const agora=new Date('2026-09-10T12:00:00Z');
const pedido={ tenantId:T,faturaId:F,valorCents:9900,tentativa:2 };
const comBanco=process.env['SEED_DATABASE_URL'] ? describe : describe.skip;
let db:PrismaClient;
function sinal() { let resolve = () => {}; const promise=new Promise<void>(r=>{resolve=r;}); return {promise,resolve}; }
comBanco('reserva da cobrança antes da rede',()=>{
  beforeAll(()=>{ db=new PrismaClient({ datasources:{ db:{ url:process.env['SEED_DATABASE_URL']! } } }); });
  afterAll(async()=>{ await db?.$disconnect(); });
  beforeEach(async()=>{
    await db.$executeRawUnsafe('TRUNCATE tenants, platform_admins CASCADE');
    await db.$executeRaw`INSERT INTO tenants(id,name) VALUES (${T}::uuid,'Loja'),(${R}::uuid,'Outra')`;
    await db.$executeRaw`INSERT INTO platform_admins(id,email_key,name,password_hash) VALUES (${A}::uuid,'reserva','Admin','hash')`;
    await db.$executeRaw`INSERT INTO invoices(id,tenant_id,plan_code,amount_cents,period_start,period_end,due_at)
      VALUES (${F}::uuid,${T}::uuid,'pro',9900,${agora},${new Date(agora.getTime()+86400000)},${agora})`;
    await db.$executeRaw`INSERT INTO billing_customers(tenant_id,psp_customer_id,psp_method_id,brand,last4,exp_month,exp_year)
      VALUES (${T}::uuid,'cus_original','pm_original','visa','4242',12,2030)`;
  });
  it('a chamada em voo bloqueia baixa, cancelamento e outro worker antes de existir charge id',async()=>{
    const psp=new FakePspProvider();
    const entrou=sinal(); const liberar=sinal();
    psp.cobrar=vi.fn(async()=>{ entrou.resolve();await liberar.promise;return { estado:'pendente' as const,chargeId:'pi_unico' }; });
    const chamada=cobrarComReserva(pedido,psp,agora);
    await entrou.promise;
    try {
      await expect(cancelarFatura({ adminId:A,faturaId:F,motivo:'Concorrência' })).rejects.toMatchObject({ code:'not_voidable' });
      await expect(pagarFatura({ adminId:A,faturaId:F,metodo:'manual' })).rejects.toMatchObject({ code:'not_payable' });
      expect(await cobrarComReserva(pedido,psp,agora)).toMatchObject({ estado:'pendente',chargeId:'' });
      expect(psp.cobrar).toHaveBeenCalledTimes(1);
    } finally { liberar.resolve(); }
    expect(await chamada).toMatchObject({ chargeId:'pi_unico' });
  });
  it('timeout e troca de cartão retomam o mesmo snapshot e a mesma tentativa',async()=>{
    const psp=new FakePspProvider();const chamadas:PedidoDeCobranca[]=[];
    psp.cobrar=async(p)=>{ chamadas.push(p);if(chamadas.length===1)throw new Error('timeout');return { estado:'pendente',chargeId:'pi_unico' }; };
    await expect(cobrarComReserva(pedido,psp,agora)).rejects.toThrow('timeout');
    await db.$executeRaw`UPDATE billing_customers SET psp_customer_id='cus_novo',psp_method_id='pm_novo'`;
    await cobrarComReserva(pedido,psp,new Date(agora.getTime()+60_000));
    expect(chamadas).toHaveLength(2);expect(chamadas[1]).toEqual(chamadas[0]);
    expect(chamadas[1]).toMatchObject({ pspCustomerId:'cus_original',pspMethodId:'pm_original' });
  });
  it('recusa definitiva é reaproveitada sem chamar a rede e permite cancelamento manual',async()=>{
    const psp=new FakePspProvider();const cobrar=vi.spyOn(psp,'cobrar');
    await cobrarComReserva(pedido,psp,agora);await cobrarComReserva(pedido,psp,agora);
    expect(cobrar).toHaveBeenCalledTimes(1);
    await expect(cancelarFatura({ adminId:A,faturaId:F,motivo:'Acordo comercial' })).resolves.toMatchObject({ tenantId:T });
  });
  it('depois de 23h uma busca vazia mantém a reserva e não cria outra cobrança',async()=>{
    const psp=new FakePspProvider();psp.cobrar=vi.fn(async()=>{ throw new Error('timeout'); });
    await expect(cobrarComReserva(pedido,psp,agora)).rejects.toThrow('timeout');
    const recuperar=vi.fn(async()=>null);
    await expect(cobrarComReserva(pedido,{...psp,cobrar:psp.cobrar,consultar:psp.consultar,estornar:psp.estornar,recuperar},
      new Date(agora.getTime()+24*3600000))).rejects.toThrow('cobranca_antiga_exige_conciliacao');
    expect(psp.cobrar).toHaveBeenCalledTimes(1);expect(recuperar).toHaveBeenCalledTimes(1);
    await expect(pagarFatura({ adminId:A,faturaId:F,metodo:'manual' })).rejects.toMatchObject({ code:'not_payable' });
  });
  it('tentativa antiga recuperada amarra o mesmo intent sem recriar',async()=>{
    const psp=new FakePspProvider();psp.cobrar=vi.fn(async()=>{ throw new Error('timeout'); });
    await expect(cobrarComReserva(pedido,psp,agora)).rejects.toThrow();
    const recuperador={ cobrar:psp.cobrar,consultar:psp.consultar,estornar:psp.estornar,
      recuperar:async()=>({ estado:'paga' as const,chargeId:'pi_recuperado' }) };
    expect(await cobrarComReserva(pedido,recuperador,new Date(agora.getTime()+24*3600000))).toEqual({ estado:'paga',chargeId:'pi_recuperado' });
    const [f]=await db.$queryRaw<{ psp_charge_id:string }[]>`SELECT psp_charge_id FROM invoices WHERE id=${F}::uuid`;
    expect(f?.psp_charge_id).toBe('pi_recuperado');expect(psp.cobrar).toHaveBeenCalledTimes(1);
  });
  it('posse vencida recuperada não aceita resultado atrasado de outro worker',async()=>{
    const psp=new FakePspProvider();const entrou=sinal();const liberar=sinal();
    psp.cobrar=vi.fn().mockImplementationOnce(async()=>{entrou.resolve();await liberar.promise;return {estado:'paga',chargeId:'pi_atrasado'};})
      .mockResolvedValueOnce({estado:'pendente',chargeId:'pi_atual'});
    const antiga=cobrarComReserva(pedido,psp,agora);await entrou.promise;
    try { expect(await cobrarComReserva(pedido,psp,new Date(agora.getTime()+61000))).toMatchObject({chargeId:'pi_atual'}); }
    finally { liberar.resolve(); }
    expect(await antiga).toMatchObject({estado:'pendente',chargeId:''});
    const [f]=await db.$queryRaw<{psp_charge_id:string}[]>`SELECT psp_charge_id FROM invoices WHERE id=${F}::uuid`;
    expect(f?.psp_charge_id).toBe('pi_atual');
  });
  it('valor, tenant ou tentativa divergente e fatura encerrada nunca chegam à rede',async()=>{
    const psp=new FakePspProvider();const rede=vi.spyOn(psp,'cobrar');
    await cobrarComReserva({...pedido,tenantId:R},psp,agora);
    await cobrarComReserva({...pedido,valorCents:1},psp,agora);
    await cobrarComReserva({...pedido,tentativa:3},psp,agora);
    await pagarFatura({adminId:A,faturaId:F,metodo:'manual'});
    await cobrarComReserva(pedido,psp,agora);expect(rede).not.toHaveBeenCalled();
  });
  it('varredura alcança além das primeiras 500 faturas mesmo quando todas continuam abertas',async()=>{
    await db.$executeRaw`INSERT INTO invoices(tenant_id,kind,plan_code,amount_cents,period_start,period_end,due_at)
      SELECT ${T}::uuid,'proration','pro',9900,${agora},${new Date(agora.getTime()+86400000)},${agora}
      FROM generate_series(1,500)`;
    const ids:string[]=[];
    for await(const f of percorrerFaturasEmCobranca())ids.push(f.id);
    expect(ids).toHaveLength(501);expect(new Set(ids).size).toBe(501);
  });
  it('uma tentativa indisponível não interrompe a cobrança nem a conciliação da seguinte',async()=>{
    const outra='12500000-0000-0000-0000-000000000009';
    await db.$executeRaw`INSERT INTO invoices(id,tenant_id,kind,plan_code,amount_cents,period_start,period_end,due_at)
      VALUES(${outra}::uuid,${T}::uuid,'proration','pro',9900,${agora},${new Date(agora.getTime()+86400000)},${agora})`;
    await db.$executeRaw`UPDATE invoices SET past_due_at=${agora}`;
    const resultado=await aplicarRegua({agora:new Date(agora.getTime()+86400000),provider:{
      cobrar:async p=>{if(p.faturaId===F)throw new Error('exige conciliação');return {pago:true,metodo:'card'};},
    }});
    expect(resultado).toMatchObject({falhas:1,pagas:1});
    await db.$executeRaw`UPDATE invoices SET status='open',paid_at=NULL,paid_method=NULL,
      psp_charge_id=CASE WHEN id=${F}::uuid THEN 'pi_falha' ELSE 'pi_seguinte' END`;
    const psp=new FakePspProvider();psp.consultar=async id=>{if(id==='pi_falha')throw new Error('indisponível');return 'paga';};
    expect(await conciliarPendentes({provider:psp})).toMatchObject({falhas:1,pagas:1});
  });
  it('a reserva financeira não pode ser lida nem alterada pelo tenant',async()=>{
    const psp=new FakePspProvider();await cobrarComReserva(pedido,psp,agora);
    for(const tenant of [T,R]) {
      expect(await withTenant(tenant,tx=>tx.$queryRaw`SELECT * FROM invoice_charge_attempts`)).toEqual([]);
      expect(await withTenant(tenant,tx=>tx.$executeRaw`UPDATE invoice_charge_attempts SET state='pending'`)).toBe(0);
    }
    await expect(db.$executeRaw`INSERT INTO invoice_charge_attempts(invoice_id,tenant_id,attempt,amount_cents,psp_customer_id,psp_method_id)
      VALUES(${F}::uuid,${R}::uuid,3,9900,'cus_outro','pm_outro')`).rejects.toThrow();
  });
});
