const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, apiFetch } = require('../helpers/test-server');

test('sections CRUD + collection membership', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const call = (method, path, body) => apiFetch(server.baseUrl, method, path, body);

  await t.test('create requires name', async () => {
    const res = await call('POST', '/api/sections', {});
    assert.equal(res.status, 400);
  });

  await t.test('create + list', async () => {
    const created = await call('POST', '/api/sections', { name: 'Cooking' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Cooking');

    const list = await call('GET', '/api/sections');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].name, 'Cooking');
  });

  await t.test('duplicate name (case-insensitive) is rejected', async () => {
    await call('POST', '/api/sections', { name: 'Travel' });
    const dup = await call('POST', '/api/sections', { name: 'travel' });
    assert.equal(dup.status, 409);
  });

  await t.test('rename', async () => {
    const created = await call('POST', '/api/sections', { name: 'Old name' });
    const updated = await call('PATCH', `/api/sections/${created.body.id}`, { name: 'New name' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'New name');
  });

  await t.test('assigning a collection to an unknown section is rejected', async () => {
    const res = await call('POST', '/api/collections', { name: 'Orphan-to-be', color: '#111111', section_id: 999999 });
    assert.equal(res.status, 400);
  });

  await t.test('collection can be created and moved into a section', async () => {
    const section = await call('POST', '/api/sections', { name: 'Fitness' });
    const coll = await call('POST', '/api/collections', { name: 'Yoga', color: '#222222', section_id: section.body.id });
    assert.equal(coll.status, 201);
    assert.equal(coll.body.section_id, section.body.id);

    const cleared = await call('PATCH', `/api/collections/${coll.body.id}`, { section_id: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.section_id, null);
  });

  await t.test('deleting a section unassigns its collections instead of deleting them', async () => {
    const section = await call('POST', '/api/sections', { name: 'Temp' });
    const coll = await call('POST', '/api/collections', { name: 'Still here', color: '#333333', section_id: section.body.id });

    const del = await call('DELETE', `/api/sections/${section.body.id}`);
    assert.equal(del.status, 200);

    const got = await call('GET', `/api/collections/${coll.body.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.section_id, null);
  });
});
