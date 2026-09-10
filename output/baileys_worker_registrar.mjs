import { register } from 'node:module';
if (process.env.BAILEYS_ENSAIO_LOCAL !== '1' || process.env.NODE_ENV !== 'test') {
  throw new Error('Este interceptador pertence somente ao ensaio local.');
}
register(new URL('./baileys_worker_loader.mjs', import.meta.url));
