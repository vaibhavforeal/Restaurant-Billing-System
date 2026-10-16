// Same server, routes and React build as the installed outlet service; isolated local development data.
process.env.FORKFLOW_RUNTIME = 'browser-preview';
await import('../../apps/server/src/main.js');
