// The API's route table: wires each resource module's handlers to a method + path.
const { createApiHandler } = require('./router');
const { createCollectionsApi } = require('./collections');
const { createTagsApi } = require('./tags');
const { createPostsApi } = require('./posts');
const { createBackupApi } = require('./backup');

function createApiHandlerForDb(db) {
  const collections = createCollectionsApi(db);
  const tags = createTagsApi(db);
  const posts = createPostsApi(db);
  const backup = createBackupApi(db);

  const routes = [
    { method: 'GET', path: '/api/collections', handler: collections.list },
    { method: 'POST', path: '/api/collections', handler: collections.create },
    { method: 'GET', path: '/api/collections/:id', handler: collections.get },
    { method: 'PATCH', path: '/api/collections/:id', handler: collections.update },
    { method: 'DELETE', path: '/api/collections/:id', handler: collections.remove },

    { method: 'GET', path: '/api/tags', handler: tags.list },
    { method: 'POST', path: '/api/tags', handler: tags.create },
    { method: 'PATCH', path: '/api/tags/:id', handler: tags.update },
    { method: 'DELETE', path: '/api/tags/:id', handler: tags.remove },

    // /api/posts/stats must precede /api/posts/:id -- router.js matches top to bottom.
    { method: 'GET', path: '/api/posts/stats', handler: posts.stats },
    { method: 'GET', path: '/api/posts', handler: posts.list },
    { method: 'POST', path: '/api/posts', handler: posts.create },
    { method: 'GET', path: '/api/posts/:id', handler: posts.get },
    { method: 'PATCH', path: '/api/posts/:id', handler: posts.update },
    { method: 'DELETE', path: '/api/posts/:id', handler: posts.remove },
    { method: 'POST', path: '/api/posts/:id/tags', handler: posts.attachTag },
    { method: 'DELETE', path: '/api/posts/:id/tags/:tagId', handler: posts.detachTag },

    { method: 'GET', path: '/api/backup', handler: backup.download },
    { method: 'POST', path: '/api/backup/restore', handler: backup.restore },
  ];

  return createApiHandler(routes);
}

module.exports = { createApiHandlerForDb };
