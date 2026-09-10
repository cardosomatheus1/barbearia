import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { ConsoleMessagingProvider } from '../packages/identity/dist/index.js';
assert.equal(process.env.NODE_ENV,'test');
assert.match(process.env.CONSENTIMENTO_ENSAIO_OTP??'',/^\/tmp\/barbearia-consentimento-/);
ConsoleMessagingProvider.prototype.sendOtp=async function(message){
  await writeFile(process.env.CONSENTIMENTO_ENSAIO_OTP,JSON.stringify({code:message.code,phone:message.phoneE164}),{mode:0o600});
};
await import('../apps/api/dist/main.js');
