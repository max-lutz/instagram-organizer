// Pure-logic helpers extracted from public/app.js (guarded module.exports at the
// bottom of that file -- see the comment there). Rendering/DOM wiring isn't
// covered here; see issue #13's resolution comment for how that was verified.
const test = require('node:test');
const assert = require('node:assert/strict');
const { firstSentence, parseInstagramLink, buildPostsQuery, isVideoLink } = require('../../public/app.js');

test('firstSentence mirrors the server title-derivation heuristic', () => {
  assert.equal(firstSentence('Sheet-pan chicken thighs with lemon. Great for a weeknight.'), 'Sheet-pan chicken thighs with lemon.');
  assert.equal(firstSentence('No terminal punctuation'), 'No terminal punctuation');
  assert.equal(firstSentence(''), '');
  assert.equal(firstSentence(null), '');
});

test('parseInstagramLink recognizes posts, reels, and tv, and rejects other links', () => {
  assert.deepEqual(parseInstagramLink('https://www.instagram.com/p/ABC123/'), { type: 'p', code: 'ABC123' });
  assert.deepEqual(parseInstagramLink('https://www.instagram.com/reel/XYZ789/'), { type: 'reel', code: 'XYZ789' });
  assert.deepEqual(parseInstagramLink('https://www.instagram.com/tv/QRS456'), { type: 'tv', code: 'QRS456' });
  assert.equal(parseInstagramLink('https://example.com/not-instagram'), null);
  assert.equal(parseInstagramLink(''), null);
});

test('isVideoLink is true only for reel/tv links', () => {
  assert.equal(isVideoLink('https://www.instagram.com/reel/abc/'), true);
  assert.equal(isVideoLink('https://www.instagram.com/tv/abc/'), true);
  assert.equal(isVideoLink('https://www.instagram.com/p/abc/'), false);
  assert.equal(isVideoLink(''), false);
});

test('buildPostsQuery encodes the sidebar view as collection_id/unassigned', () => {
  assert.equal(buildPostsQuery({ view: 'all', search: '', sort: '' }), '');
  assert.equal(buildPostsQuery({ view: 'unsorted', search: '', sort: '' }), 'unassigned=true');
  assert.equal(buildPostsQuery({ view: 'collection:7', search: '', sort: '' }), 'collection_id=7');
});

test('buildPostsQuery includes trimmed search and sort', () => {
  const qs = buildPostsQuery({ view: 'all', search: '  weeknight  ', sort: 'title-asc' });
  const params = new URLSearchParams(qs);
  assert.equal(params.get('search'), 'weeknight');
  assert.equal(params.get('sort'), 'title-asc');
});

test('buildPostsQuery omits search when blank', () => {
  const params = new URLSearchParams(buildPostsQuery({ view: 'all', search: '   ', sort: 'saved-desc' }));
  assert.equal(params.has('search'), false);
});
