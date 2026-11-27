import { execFileSync } from 'node:child_process';
import { KEY, NEXT_KEY, NEXT_PORT, SHOP_PORT } from './playwright.config';

/** Creates the test projects in the running kimmi, once: their public keys are fixed. */
export default function setup() {
  const binary = process.env.KIMMI_BIN;
  const container = process.env.KIMMI_CONTAINER ?? 'kimmi-kimmi-1';
  const kimmi = (...args: string[]) =>
    binary
      ? execFileSync(binary, args, { encoding: 'utf8' })
      : execFileSync('docker', ['exec', container, 'kimmi', ...args], { encoding: 'utf8' });
  const projects = JSON.parse(kimmi('admin', 'project', 'list')) as { publicKey: string }[];
  const create = (key: string, name: string, slug: string, platform: string, port: number) => {
    if (projects.some((project) => project.publicKey === key)) return;
    kimmi('admin', 'project', 'create', '--name', name, '--slug', slug, '--platform', platform, '--origin', `http://localhost:${port}`, '--key', key);
  };
  create(KEY, 'Stack test shop', 'stack-test-shop', 'react', SHOP_PORT);
  create(NEXT_KEY, 'Stack test site', 'stack-test-site', 'next', NEXT_PORT);
}
