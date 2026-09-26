const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, apiFetch } = require('../helpers/test-server');

test('deleted-posts: list + dismiss (issue #31/#41)', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const call = (method, path, body) => apiFetch(server.baseUrl, method, path, body);

  await t.test('list is empty with no tombstones', async () => {
    const res = await call('GET', '/api/deleted-posts');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  await t.test('a deleted post shows up in the list, not dismissed by default', async () => {
    const post = await call('POST', '/api/posts', { link: 'https://instagram.com/p/tomb1', provenance: 'manual' });
    await call('DELETE', `/api/posts/${post.body.id}`);

    const res = await call('GET', '/api/deleted-posts');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].link, 'https://instagram.com/p/tomb1');
    assert.equal(res.body[0].dismissed, 0);
  });

  await t.test('?dismissed=false / ?dismissed=true filter the list', async () => {
    const before = await call('GET', '/api/deleted-posts');
    const id = before.body.find((d) => d.link === 'https://instagram.com/p/tomb1').id;

    const notDismissed = await call('GET', '/api/deleted-posts?dismissed=false');
    assert.ok(notDismissed.body.some((d) => d.id === id));

    const dismissed = await call('PATCH', `/api/deleted-posts/${id}`, { dismissed: true });
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.body.dismissed, 1);

    const stillNotDismissed = await call('GET', '/api/deleted-posts?dismissed=false');
    assert.ok(!stillNotDismissed.body.some((d) => d.id === id));

    const nowDismissed = await call('GET', '/api/deleted-posts?dismissed=true');
    assert.ok(nowDismissed.body.some((d) => d.id === id));
  });

  await t.test('update requires dismissed', async () => {
    const before = await call('GET', '/api/deleted-posts');
    const id = before.body[0].id;
    const res = await call('PATCH', `/api/deleted-posts/${id}`, {});
    assert.equal(res.status, 400);
  });

  await t.test('update on an unknown tombstone is 404', async () => {
    const res = await call('PATCH', '/api/deleted-posts/999999', { dismissed: true });
    assert.equal(res.status, 404);
  });

  await t.test('a fresh delete of the same link resets dismissed back to 0', async () => {
    // Re-add clears the tombstone (#40's invariant), then a fresh delete
    // writes a brand new tombstone -- a new deletion event should prompt
    // again on reimport even if the old one had been dismissed.
    const readded = await call('POST', '/api/posts', { link: 'https://instagram.com/p/tomb1', provenance: 'manual' });
    await call('DELETE', `/api/posts/${readded.body.id}`);

    const res = await call('GET', '/api/deleted-posts');
    const tomb = res.body.find((d) => d.link === 'https://instagram.com/p/tomb1');
    assert.ok(tomb);
    assert.equal(tomb.dismissed, 0);
  });
});
