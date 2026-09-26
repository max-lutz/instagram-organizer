const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, apiFetch } = require('../helpers/test-server');

test('posts CRUD, title derivation, search/sort, tags', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  const call = (method, path, body) => apiFetch(server.baseUrl, method, path, body);

  await t.test('create requires link and provenance', async () => {
    const missingLink = await call('POST', '/api/posts', { provenance: 'manual' });
    assert.equal(missingLink.status, 400);

    const missingProvenance = await call('POST', '/api/posts', { link: 'https://instagram.com/p/x' });
    assert.equal(missingProvenance.status, 400);

    const badProvenance = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/x',
      provenance: 'telepathy',
    });
    assert.equal(badProvenance.status, 400);
  });

  await t.test('title defaults to first sentence of description', async () => {
    const created = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/derive1',
      provenance: 'manual',
      description: 'Sheet-pan chicken thighs with lemon. Great for a weeknight.',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.title, 'Sheet-pan chicken thighs with lemon.');
    assert.equal(created.body.title_manual, 0);
  });

  await t.test('explicit title on create is marked manual and survives description edits', async () => {
    const created = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/derive2',
      provenance: 'manual',
      description: 'Original caption.',
      title: 'My own title',
    });
    assert.equal(created.body.title, 'My own title');
    assert.equal(created.body.title_manual, 1);

    const updated = await call('PATCH', `/api/posts/${created.body.id}`, {
      description: 'Completely different caption now.',
    });
    assert.equal(updated.body.title, 'My own title');
  });

  await t.test('title re-derives on description edit until hand-edited', async () => {
    const created = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/derive3',
      provenance: 'manual',
      description: 'First caption sentence. More text.',
    });
    const afterDescEdit = await call('PATCH', `/api/posts/${created.body.id}`, {
      description: 'Second caption sentence! Trailing.',
    });
    assert.equal(afterDescEdit.body.title, 'Second caption sentence!');

    const handEdited = await call('PATCH', `/api/posts/${created.body.id}`, { title: 'Hand edited' });
    assert.equal(handEdited.body.title_manual, 1);

    const afterHandEdit = await call('PATCH', `/api/posts/${created.body.id}`, {
      description: 'Yet another caption.',
    });
    assert.equal(afterHandEdit.body.title, 'Hand edited');
  });

  await t.test('link is immutable and unique', async () => {
    const created = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/immutable',
      provenance: 'manual',
    });
    const patch = await call('PATCH', `/api/posts/${created.body.id}`, { link: 'https://instagram.com/p/x' });
    assert.equal(patch.status, 400);

    const dup = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/immutable',
      provenance: 'manual',
    });
    assert.equal(dup.status, 409);
  });

  await t.test('collection_id must reference an existing collection', async () => {
    const res = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/badcoll',
      provenance: 'manual',
      collection_id: 999999,
    });
    assert.equal(res.status, 400);
  });

  await t.test('search matches title, description, and note only', async () => {
    await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/search1',
      provenance: 'manual',
      description: 'A pasta recipe for weeknights.',
    });
    await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/search2',
      provenance: 'manual',
      note: 'Great pasta place to visit.',
      description: 'City guide.',
    });
    await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/search3',
      provenance: 'manual',
      description: 'Unrelated travel content.',
    });

    const results = await call('GET', '/api/posts?search=pasta');
    assert.equal(results.status, 200);
    assert.equal(results.body.length, 2);
  });

  await t.test('sort options order by created_at / updated_at / title', async () => {
    const a = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/sortA',
      provenance: 'manual',
      title: 'Banana',
    });
    await new Promise((r) => setTimeout(r, 2));
    const b = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/sortB',
      provenance: 'manual',
      title: 'Apple',
    });

    const newest = await call('GET', '/api/posts?sort=saved-desc');
    const newestIds = newest.body.map((p) => p.id);
    assert.ok(newestIds.indexOf(b.body.id) < newestIds.indexOf(a.body.id));

    const oldest = await call('GET', '/api/posts?sort=saved-asc');
    const oldestIds = oldest.body.map((p) => p.id);
    assert.ok(oldestIds.indexOf(a.body.id) < oldestIds.indexOf(b.body.id));

    const titleAsc = await call('GET', '/api/posts?sort=title-asc');
    const ids = titleAsc.body.map((p) => p.id);
    assert.ok(ids.indexOf(b.body.id) < ids.indexOf(a.body.id));
  });

  await t.test('collection_id and unassigned filters', async () => {
    const coll = await call('POST', '/api/collections', { name: 'Filtered', color: '#000000' });
    const inColl = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/filter-in',
      provenance: 'manual',
      collection_id: coll.body.id,
    });
    const unsorted = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/filter-out',
      provenance: 'manual',
    });

    const byCollection = await call('GET', `/api/posts?collection_id=${coll.body.id}`);
    assert.deepEqual(
      byCollection.body.map((p) => p.id),
      [inColl.body.id]
    );

    const unassigned = await call('GET', '/api/posts?unassigned=true');
    assert.ok(unassigned.body.some((p) => p.id === unsorted.body.id));
    assert.ok(!unassigned.body.some((p) => p.id === inColl.body.id));
  });

  await t.test('stats reports total and unassigned counts', async () => {
    const before = await call('GET', '/api/posts/stats');
    await call('POST', '/api/posts', { link: 'https://instagram.com/p/stats1', provenance: 'manual' });
    const after = await call('GET', '/api/posts/stats');
    assert.equal(after.body.total, before.body.total + 1);
  });

  await t.test('tag attach/detach and the 4-tag cap', async () => {
    const post = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/tagcap',
      provenance: 'manual',
    });
    const tagIds = [];
    for (let i = 0; i < 4; i++) {
      const tag = await call('POST', '/api/tags', { name: `tag${i}`, color: '#666666' });
      tagIds.push(tag.body.id);
      const attached = await call('POST', `/api/posts/${post.body.id}/tags`, { tag_id: tag.body.id });
      assert.equal(attached.status, 200);
    }
    assert.equal((await call('GET', `/api/posts/${post.body.id}`)).body.tags.length, 4);

    const fifthTag = await call('POST', '/api/tags', { name: 'tag5', color: '#777777' });
    const overCap = await call('POST', `/api/posts/${post.body.id}/tags`, { tag_id: fifthTag.body.id });
    assert.equal(overCap.status, 422);

    const detach = await call('DELETE', `/api/posts/${post.body.id}/tags/${tagIds[0]}`);
    assert.equal(detach.status, 200);
    assert.equal(detach.body.tags.length, 3);
  });

  await t.test('delete post', async () => {
    const post = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/deleteme',
      provenance: 'manual',
    });
    const del = await call('DELETE', `/api/posts/${post.body.id}`);
    assert.equal(del.status, 200);
    const got = await call('GET', `/api/posts/${post.body.id}`);
    assert.equal(got.status, 404);
  });

  await t.test('delete tombstones the post, and re-adding the link clears it (issue #40)', async () => {
    const coll = await call('POST', '/api/collections', { name: 'Tombstoned', color: '#888888' });
    const tag = await call('POST', '/api/tags', { name: 'ephemeral', color: '#999999' });
    const link = 'https://instagram.com/p/tombstone-roundtrip';
    const post = await call('POST', '/api/posts', {
      link,
      provenance: 'manual',
      collection_id: coll.body.id,
      description: 'Here today.',
      note: 'a note',
      owner_name: 'Someone',
      owner_username: 'someone_handle',
    });
    await call('POST', `/api/posts/${post.body.id}/tags`, { tag_id: tag.body.id });

    await call('DELETE', `/api/posts/${post.body.id}`);

    const tombstone = server.db.prepare('SELECT * FROM deleted_posts WHERE link = ?').get(link);
    assert.ok(tombstone);
    assert.equal(tombstone.description, 'Here today.');
    assert.equal(tombstone.note, 'a note');
    assert.equal(tombstone.owner_name, 'Someone');
    assert.equal(tombstone.owner_username, 'someone_handle');
    assert.equal(tombstone.collection_name, 'Tombstoned');
    assert.deepEqual(JSON.parse(tombstone.tags), ['ephemeral']);

    // Manual re-add clears the tombstone (#30's invariant).
    const readded = await call('POST', '/api/posts', { link, provenance: 'manual' });
    assert.equal(readded.status, 201);
    const cleared = server.db.prepare('SELECT * FROM deleted_posts WHERE link = ?').get(link);
    assert.equal(cleared, undefined);
  });

  await t.test('reimport_dismissed defaults to 0 and can be set via PATCH (issue #31/#41)', async () => {
    const post = await call('POST', '/api/posts', {
      link: 'https://instagram.com/p/reimport-dismiss',
      provenance: 'instagram-import',
    });
    assert.equal(post.body.reimport_dismissed, 0);

    const dismissed = await call('PATCH', `/api/posts/${post.body.id}`, { reimport_dismissed: true });
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.body.reimport_dismissed, 1);

    // Unrelated fields are unaffected by the dismiss.
    const undismissed = await call('PATCH', `/api/posts/${post.body.id}`, { note: 'still here', reimport_dismissed: false });
    assert.equal(undismissed.body.reimport_dismissed, 0);
    assert.equal(undismissed.body.note, 'still here');
  });
});
