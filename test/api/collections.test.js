const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, apiFetch } = require('../helpers/test-server');

test('collections CRUD + deletion post-fate', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const call = (method, path, body) => apiFetch(server.baseUrl, method, path, body);

  await t.test('create requires name and color', async () => {
    const res = await call('POST', '/api/collections', { name: 'Recipes' });
    assert.equal(res.status, 400);
  });

  await t.test('create + list + get', async () => {
    const created = await call('POST', '/api/collections', { name: 'Recipes', color: '#ff0000' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Recipes');
    assert.equal(created.body.post_count, 0);

    const list = await call('GET', '/api/collections');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);

    const got = await call('GET', `/api/collections/${created.body.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.id, created.body.id);
  });

  await t.test('duplicate name (case-insensitive) is rejected', async () => {
    await call('POST', '/api/collections', { name: 'Travel', color: '#00ff00' });
    const dup = await call('POST', '/api/collections', { name: 'travel', color: '#0000ff' });
    assert.equal(dup.status, 409);
  });

  await t.test('get unknown collection is 404', async () => {
    const res = await call('GET', '/api/collections/999999');
    assert.equal(res.status, 404);
  });

  await t.test('update changes fields and bumps updated_at', async () => {
    const created = await call('POST', '/api/collections', { name: 'Movies', color: '#111111' });
    const updated = await call('PATCH', `/api/collections/${created.body.id}`, { note: 'to watch' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.note, 'to watch');
    assert.equal(updated.body.name, 'Movies');
    assert.ok(updated.body.updated_at >= created.body.updated_at);
  });

  await t.test('delete without deletePosts keeps posts, sets collection_id null', async () => {
    const coll = await call('POST', '/api/collections', { name: 'Keepers', color: '#222222' });
    const post = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/keep1',
      provenance: 'manual',
      collection_id: coll.body.id,
    });

    const del = await call('DELETE', `/api/collections/${coll.body.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.postsDeleted, 0);

    const survived = await call('GET', `/api/posts/${post.body.id}`);
    assert.equal(survived.status, 200);
    assert.equal(survived.body.collection_id, null);
  });

  await t.test('delete with deletePosts=true removes its posts', async () => {
    const coll = await call('POST', '/api/collections', { name: 'Purge', color: '#333333' });
    const post = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/purge1',
      provenance: 'manual',
      collection_id: coll.body.id,
    });

    const del = await call('DELETE', `/api/collections/${coll.body.id}?deletePosts=true`);
    assert.equal(del.status, 200);
    assert.equal(del.body.postsDeleted, 1);

    const gone = await call('GET', `/api/posts/${post.body.id}`);
    assert.equal(gone.status, 404);
  });

  await t.test('delete with deletePosts=true tombstones its posts (issue #40)', async () => {
    const coll = await call('POST', '/api/collections', { name: 'PurgeWithTags', color: '#444444' });
    const tag = await call('POST', '/api/tags', { name: 'purge-tag', color: '#555555' });
    const post = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/purge-tombstone',
      provenance: 'manual',
      collection_id: coll.body.id,
      description: 'Doomed post.',
    });
    await call('POST', `/api/posts/${post.body.id}/tags`, { tag_id: tag.body.id });

    await call('DELETE', `/api/collections/${coll.body.id}?deletePosts=true`);

    const tombstone = server.db
      .prepare('SELECT * FROM deleted_posts WHERE link = ?')
      .get('https://instagram.com/p/purge-tombstone');
    assert.ok(tombstone);
    assert.equal(tombstone.collection_name, 'PurgeWithTags');
    assert.deepEqual(JSON.parse(tombstone.tags), ['purge-tag']);
  });

  await t.test('delete without deletePosts does not tombstone survivors', async () => {
    const coll = await call('POST', '/api/collections', { name: 'NoPurge', color: '#666666' });
    await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/no-purge',
      provenance: 'manual',
      collection_id: coll.body.id,
    });

    await call('DELETE', `/api/collections/${coll.body.id}`);

    const tombstone = server.db
      .prepare('SELECT * FROM deleted_posts WHERE link = ?')
      .get('https://instagram.com/p/no-purge');
    assert.equal(tombstone, undefined);
  });
});
