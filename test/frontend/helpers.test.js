// Pure-logic helpers extracted from public/app.js (guarded module.exports at the
// bottom of that file -- see the comment there). Rendering/DOM wiring isn't
// covered here; see issue #13's resolution comment for how that was verified.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  firstSentence,
  parseInstagramLink,
  buildPostsQuery,
  isVideoLink,
  parseInstagramExport,
  computeReimportDiff,
} = require('../../public/app.js');

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

// Mimics a Meta "Download your information" saved-collections export: two
// collection blocks (Recipes with two posts, Travel with one), matching the
// landmark rows docs/reference/prototype/v0.0/clipping-box.html's parser splits
// on. Recipes' second post has no Propriétaire section, to check owner fields
// default to empty rather than leaking the previous post's.
const SAMPLE_EXPORT = `
<div class="_a6-g">
  <table><tr><td class="_a6_q">Nom</td><td class="_2piu _a6_r">Recipes</td></tr></table>
  <h2 class="_a6-h">Contenu multimédia</h2>
  <table>
    <tr><td colspan="2" class="_a6_q">URL<div><a target="_blank" href="https://www.instagram.com/p/AAA111/">link</a></div></td></tr>
    <tr><td class="_a6_q">Légende</td><td class="_2piu _a6_r">Sheet-pan chicken &amp; lemon.<br>
Great for weeknights.</td></tr>
    <h2 class="_a6-h">Propriétaire</h2>
    <table>
      <tr><td class="_a6_q">Nom</td><td class="_2piu _a6_r">Jane Doe</td></tr>
      <tr><td class="_a6_q">Nom de profil</td><td class="_2piu _a6_r">janedoe</td></tr>
    </table>
  </table>
  <table>
    <tr><td colspan="2" class="_a6_q">URL<div><a target="_blank" href="https://www.instagram.com/reel/BBB222/">link</a></div></td></tr>
    <tr><td class="_a6_q">Légende</td><td class="_2piu _a6_r">Weekend pancakes&#233; special</td></tr>
  </table>
</div>
<div class="_a6-g">
  <table><tr><td class="_a6_q">Nom</td><td class="_2piu _a6_r">  Travel  </td></tr></table>
  <h2 class="_a6-h">Contenu multimédia</h2>
  <table>
    <tr><td colspan="2" class="_a6_q">URL<div><a target="_blank" href="https://www.instagram.com/p/CCC333/">link</a></div></td></tr>
    <tr><td class="_a6_q">Légende</td><td class="_2piu _a6_r">City guide.</td></tr>
    <h2 class="_a6-h">Propriétaire</h2>
    <table>
      <tr><td class="_a6_q">Nom</td><td class="_2piu _a6_r">Travel Bot</td></tr>
      <tr><td class="_a6_q">Nom de profil</td><td class="_2piu _a6_r">travelbot</td></tr>
    </table>
  </table>
</div>
`;

test('parseInstagramExport extracts posts with their collection, caption, and owner', () => {
  const posts = parseInstagramExport(SAMPLE_EXPORT);
  assert.equal(posts.length, 3);
  assert.deepEqual(posts[0], {
    link: 'https://www.instagram.com/p/AAA111/',
    description: 'Sheet-pan chicken & lemon. Great for weeknights.',
    ownerName: 'Jane Doe',
    ownerUsername: 'janedoe',
    collectionName: 'Recipes',
  });
  assert.deepEqual(posts[2], {
    link: 'https://www.instagram.com/p/CCC333/',
    description: 'City guide.',
    ownerName: 'Travel Bot',
    ownerUsername: 'travelbot',
    collectionName: 'Travel',
  });
});

test('parseInstagramExport decodes numeric entities and strips tags from captions', () => {
  const posts = parseInstagramExport(SAMPLE_EXPORT);
  assert.equal(posts[0].description, 'Sheet-pan chicken & lemon. Great for weeknights.');
  assert.equal(posts[1].description, 'Weekend pancakesé special');
});

test('parseInstagramExport leaves owner fields empty when a post has no Propriétaire section', () => {
  const posts = parseInstagramExport(SAMPLE_EXPORT);
  assert.equal(posts[1].ownerName, '');
  assert.equal(posts[1].ownerUsername, '');
});

test('parseInstagramExport trims whitespace from the collection name', () => {
  const posts = parseInstagramExport(SAMPLE_EXPORT);
  assert.equal(posts[2].collectionName, 'Travel');
});

test('parseInstagramExport returns an empty array for a file with no recognizable posts', () => {
  assert.deepEqual(parseInstagramExport('<html><body>not an export</body></html>'), []);
});

// issue #31/#41's reimport diff.
test('computeReimportDiff finds direction (a) re-add candidates: export links with a live tombstone', () => {
  const parsed = [
    { link: 'https://instagram.com/p/a', description: '', ownerName: '', ownerUsername: '', collectionName: '' },
    { link: 'https://instagram.com/p/b', description: '', ownerName: '', ownerUsername: '', collectionName: '' },
  ];
  const existingPosts = [];
  const deletedPosts = [
    { id: 1, link: 'https://instagram.com/p/a', dismissed: 0 },
    { id: 2, link: 'https://instagram.com/p/missing', dismissed: 0 },
  ];

  const { readdCandidates, dropCandidates, tombstoneByLink } = computeReimportDiff(parsed, existingPosts, deletedPosts);
  assert.equal(readdCandidates.length, 1);
  assert.equal(readdCandidates[0].exportPost.link, 'https://instagram.com/p/a');
  assert.equal(readdCandidates[0].tombstone.id, 1);
  assert.deepEqual(dropCandidates, []);
  assert.equal(tombstoneByLink.has('https://instagram.com/p/a'), true);
  assert.equal(tombstoneByLink.has('https://instagram.com/p/b'), false);
});

// Regression test: a dismissed tombstone must NOT surface in the review
// screen, but its link must still be kept out of performImport's normal add
// loop (via tombstoneByLink) -- otherwise "dismissed" silently re-adds the
// Post as brand new on the very next reimport instead of leaving it deleted.
test('computeReimportDiff excludes dismissed tombstones from readdCandidates but keeps them in tombstoneByLink', () => {
  const parsed = [{ link: 'https://instagram.com/p/a', description: '', ownerName: '', ownerUsername: '', collectionName: '' }];
  const deletedPosts = [{ id: 1, link: 'https://instagram.com/p/a', dismissed: 1 }];

  const { readdCandidates, tombstoneByLink } = computeReimportDiff(parsed, [], deletedPosts);
  assert.deepEqual(readdCandidates, []);
  assert.equal(tombstoneByLink.has('https://instagram.com/p/a'), true);
});

test('computeReimportDiff finds direction (b) drop candidates: live instagram-import posts missing from the export', () => {
  const parsed = [{ link: 'https://instagram.com/p/still-here', description: '', ownerName: '', ownerUsername: '', collectionName: '' }];
  const existingPosts = [
    { id: 10, link: 'https://instagram.com/p/still-here', provenance: 'instagram-import', reimport_dismissed: 0 },
    { id: 11, link: 'https://instagram.com/p/gone', provenance: 'instagram-import', reimport_dismissed: 0 },
    { id: 12, link: 'https://instagram.com/p/manual-gone', provenance: 'manual', reimport_dismissed: 0 },
    { id: 13, link: 'https://instagram.com/p/dismissed-gone', provenance: 'instagram-import', reimport_dismissed: 1 },
  ];

  const { dropCandidates } = computeReimportDiff(parsed, existingPosts, []);
  assert.deepEqual(dropCandidates.map((p) => p.id), [11]);
});
