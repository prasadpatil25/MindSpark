import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { extractFunction } from './helpers/load-app-fns.mjs';

function bootContext(host) {
  const context = vm.createContext({
    window: host ? { MINDSPARK_HOST: host } : {},
    Store: null, MODE: '', ServerStore: { id: 'server' },
    CloudStore: { tryInit: async () => true },
    probeHealth: async () => 'server',
  });
  vm.runInContext(extractFunction('initStore'), context);
  return context;
}
test('an opt-in host store runs readiness before selection and retains server editing behavior', async () => {
  let ready = false;
  const store = { id: 'host' };
  const context = bootContext({ store, ready: async () => { ready = true; } });
  const result = await context.initStore();
  assert.equal(ready, true);
  assert.equal(context.Store, store);
  assert.equal(result.mode, 'server');
  assert.equal(result.loggedIn, true);
});
test('host readiness failure never falls back to a forge or a standalone server', async () => {
  const context = bootContext({ store: {}, ready: async () => { throw new Error('expired session'); } });
  await assert.rejects(context.initStore(), /expired session/);
  assert.equal(context.Store, null);
});
test('standalone storage selection is unchanged without a host', async () => {
  const context = bootContext();
  await context.initStore();
  assert.equal(context.Store, context.ServerStore);
});
test('hosted library failures stop boot rather than creating a misleading empty map', async () => {
  const context = vm.createContext({
    window: { MINDSPARK_HOST: {} }, URLSearchParams, location: { search: '' },
    loadUserTemplates() {}, consumePendingImport: async () => false,
    Store: { list: async () => { throw new Error('storage unavailable'); } },
  });
  vm.runInContext(extractFunction('_proceedBoot'), context);
  await assert.rejects(context._proceedBoot(), /storage unavailable/);
});
test('snapshot links can point at the host entry point while standalone links stay local', async () => {
  for (const host of [null, { shareBase: 'https://maps.example.com/' }]) {
    const context = vm.createContext({
      window: { MINDSPARK_HOST: host }, location: { origin: 'https://maps.example.com', pathname: '/editor/' },
      map: {}, _shareePayload: () => ({}), _gzip: async () => null,
      _b64urlFromBytes: () => 'token', TextEncoder,
    });
    vm.runInContext(extractFunction('buildShareLink'), context);
    assert.equal(await context.buildShareLink(), 'https://maps.example.com/' + (host ? '' : 'editor/') + '#view=rtoken');
  }
});
