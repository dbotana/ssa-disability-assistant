// The turn scenarios: the dialog layer driven through its ports.
//
// The YAML files in tools/turn-scenarios/ are the shared contract between the
// JS turn controller and the Android TurnController — the same files run
// against both (see tools/turn-runner.mjs, which this test delegates to).
// Nothing here touches the DOM, the microphone, or the clock.
//
// Makes no network requests.

import { runAll } from '../tools/turn-runner.mjs';

const failures = await runAll();
if (failures) {
  console.error(`\n${failures} scenario failure(s)`);
  process.exit(1);
}
console.log('\nturn scenarios: all passed');
