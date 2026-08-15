'use strict';

const Module = require('node:module');
const originalLoad = Module._load;
const kind = process.env.HS_BOOTSTRAP_FAILURE_KIND;
const secret = 'Bearer synthetic-bootstrap-secret C:\\private\\bootstrap.js';

Module._load = function bootstrapFailureInjector(request, parent, isMain) {
  if (kind === 'org' && request === './job-org-context') {
    return { requireJobOrgContext() { throw new Error(secret); } };
  }
  if (kind === 'mode' && request === './db-mode') {
    const actual = originalLoad.apply(this, arguments);
    return { ...actual, resolveDatabaseMode() { throw new Error(secret); } };
  }
  if (['./db', './analyzer', './report'].includes(request)) {
    throw new Error('DATABASE_DEPENDENCY_LOADED');
  }
  return originalLoad.apply(this, arguments);
};
