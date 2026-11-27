import { execFileSync } from 'node:child_process';
import { KEY, SHOP_PORT } from './playwright.config';

/** Creates the test project in the running container, once: its public key is fixed. */
export default function setup() {
  const container = process.env.KIMMI_CONTAINER ?? 'kimmi-kimmi-1';
  const kimmi = (...args: string[]) => execFileSync('docker', ['exec', container, 'kimmi', ...args], { encoding: 'utf8' });
  const projects = JSON.parse(kimmi('admin', 'project', 'list')) as { publicKey: string }[];
  if (projects.some((project) => project.publicKey === KEY)) return;
  kimmi('admin', 'project', 'create', '--name', 'Stack test shop', '--slug', 'stack-test-shop', '--platform', 'react',
    '--origin', `http://localhost:${SHOP_PORT}`, '--key', KEY);
}
