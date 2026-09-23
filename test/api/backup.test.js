const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, apiFetch } = require('../helpers/test-server');
const { SCHEMA_VERSION } = require('../../src/api/backup');

test('backup download + restore', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const call = (method, path, body) => apiFetch(server.baseUrl, method, path, body);

  await t.test('download mirrors collections, tags, and posts with tag_ids', async () => {
    const coll = await call('POST', '/api/collections', { name: 'Recipes', color: '#ff0000', note: 'yum' });
    const tag = await call('POST', '/api/tags', { name: 'favorite', color: '#00ff00' });
    const post = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/backup1',
      provenance: 'manual',
      collection_id: coll.body.id,
      description: 'A lovely dish.',
      owner_name: 'Chef',
      owner_username: 'chef_handle',
    });
    await call('POST', `/api/posts/${post.body.id}/tags`, { tag_id: tag.body.id });

    const backup = await call('GET', '/api/backup');
    assert.equal(backup.status, 200);
    assert.equal(backup.body.schema_version, SCHEMA_VERSION);
    assert.equal(backup.body.collections.length, 1);
    assert.equal(backup.body.collections[0].name, 'Recipes');
    assert.equal(backup.body.tags.length, 1);
    assert.equal(backup.body.posts.length, 1);
    const backedUpPost = backup.body.posts[0];
    assert.equal(backedUpPost.link, 'https://instagram.com/p/backup1');
    assert.equal(backedUpPost.owner_name, 'Chef');
    assert.equal(backedUpPost.owner_username, 'chef_handle');
    assert.deepEqual(backedUpPost.tag_ids, [tag.body.id]);
  });

  await t.test('restore rejects an unsupported schema_version', async () => {
    const res = await call('POST', '/api/backup/restore', { schema_version: 999, collections: [], tags: [], posts: [] });
    assert.equal(res.status, 400);
  });

  await t.test('restore rejects non-array fields', async () => {
    const res = await call('POST', '/api/backup/restore', { schema_version: SCHEMA_VERSION, collections: 'nope', tags: [], posts: [] });
    assert.equal(res.status, 400);
  });

  await t.test('restore wipes-and-replaces existing data', async () => {
    // Seed some data that should be gone after restore.
    await call('POST', '/api/collections', { name: 'Stale', color: '#333333' });
    await call('POST', '/api/posts', { link: 'https://instagram.com/p/stale', provenance: 'manual' });

    const payload = {
      schema_version: SCHEMA_VERSION,
      collections: [{ id: 50, name: 'Restored Collection', note: null, color: '#123456', created_at: 1, updated_at: 1 }],
      tags: [{ id: 60, name: 'restored-tag', color: '#654321', created_at: 1, updated_at: 1 }],
      posts: [
        {
          id: 70,
          link: 'https://instagram.com/p/restored',
          collection_id: 50,
          title: 'Restored title',
          title_manual: 1,
          description: 'Restored description',
          note: 'Restored note',
          owner_name: 'Owner',
          owner_username: 'owner_handle',
          source: 'instagram',
          provenance: 'manual',
          created_at: 1,
          updated_at: 1,
          tag_ids: [60],
        },
      ],
    };

    const res = await call('POST', '/api/backup/restore', payload);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { restored: true, collections: 1, tags: 1, posts: 1 });

    const collections = await call('GET', '/api/collections');
    assert.equal(collections.body.length, 1);
    assert.equal(collections.body[0].id, 50);
    assert.equal(collections.body[0].name, 'Restored Collection');

    const posts = await call('GET', '/api/posts');
    assert.equal(posts.body.length, 1);
    assert.equal(posts.body[0].id, 70);
    assert.equal(posts.body[0].collection_id, 50);
    assert.equal(posts.body[0].tags.length, 1);
    assert.equal(posts.body[0].tags[0].id, 60);

    const tags = await call('GET', '/api/tags');
    assert.equal(tags.body.length, 1);
    assert.equal(tags.body[0].id, 60);
  });

  await t.test('restore round-trips a downloaded backup', async () => {
    const before = await call('GET', '/api/backup');
    const restored = await call('POST', '/api/backup/restore', before.body);
    assert.equal(restored.status, 200);
    const after = await call('GET', '/api/backup');
    assert.deepEqual(after.body, before.body);
  });
});
