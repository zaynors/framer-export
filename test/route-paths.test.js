const test = require('node:test');
const assert = require('node:assert/strict');

const { routePathToLocalFile } = require('../scripts/export');

test('routePathToLocalFile maps root route to index.html', () => {
  assert.equal(routePathToLocalFile('/'), 'index.html');
});

test('routePathToLocalFile maps top-level routes to slug/index.html', () => {
  assert.equal(routePathToLocalFile('/blogs'), 'blogs/index.html');
  assert.equal(routePathToLocalFile('/pricing/'), 'pricing/index.html');
});

test('routePathToLocalFile maps nested routes to nested/index.html', () => {
  assert.equal(routePathToLocalFile('/blog/post-slug'), 'blog/post-slug/index.html');
});
