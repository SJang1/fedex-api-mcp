import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createFedExClient, readFedExConfig } from './fedex.js';
import { createServer } from './server.js';

try {
  const fedex = createFedExClient(readFedExConfig());
  serveStdio(() => createServer(fedex));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
