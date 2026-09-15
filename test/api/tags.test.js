const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, apiFetch } = require('../helpers/test-server');

test('tags CRUD', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const call = (method, path, body) => apiFetch(server.baseUrl, method, path, body);

  await t.test('create + list', async () => {
    const created = await call('POST', '/api/tags', { name: 'recipe', color: '#abcdef' });
    assert.equal(created.status, 201);

    const list = await call('GET', '/api/tags');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].name, 'recipe');
  });

  await t.test('duplicate name rejected', async () => {
    await call('POST', '/api/tags', { name: 'travel', color: '#111111' });
    const dup = await call('POST', '/api/tags', { name: 'Travel', color: '#222222' });
    assert.equal(dup.status, 409);
  });

  await t.test('update', async () => {
    const created = await call('POST', '/api/tags', { name: 'watch-later', color: '#333333' });
    const updated = await call('PATCH', `/api/tags/${created.body.id}`, { color: '#444444' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.color, '#444444');
    assert.equal(updated.body.name, 'watch-later');
  });

  await t.test('delete cascades off posts', async () => {
    const tag = await call('POST', '/api/tags', { name: 'gone-soon', color: '#555555' });
    const post = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/tagcascade',
      provenance: 'manual',
    });
    await call('POST', `/api/posts/${post.body.id}/tags`, { tag_id: tag.body.id });

    const del = await call('DELETE', `/api/tags/${tag.body.id}`);
    assert.equal(del.status, 200);

    const got = await call('GET', `/api/posts/${post.body.id}`);
    assert.deepEqual(got.body.tags, []);
  });
});
