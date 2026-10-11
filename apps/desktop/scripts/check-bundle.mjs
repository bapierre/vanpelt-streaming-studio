/* global process */
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

if (process.platform === 'darwin') {
  const node = fileURLToPath(
    new URL(
      '../src-tauri/target/release/bundle/macos/streamhub.app/Contents/MacOS/streamhub-node',
      import.meta.url,
    ),
  );
  // Test the re-signed sidecar, not the developer's Node; signing can break V8 startup.
  execFileSync(
    process.execPath,
    ['--test', fileURLToPath(new URL('./bundle.test.mjs', import.meta.url))],
    {
      stdio: 'inherit',
      env: { ...process.env, STREAMHUB_TEST_NODE: node },
    },
  );
}
