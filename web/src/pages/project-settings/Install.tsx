import { Copy, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useProject } from '@/api/queries';
import { useRotateKey } from '@/api/settings';
import type { Platform, Project } from '@/api/types';
import { ago, PLATFORM_LABEL } from '@/lib/format';
import {
  Button,
  CodeBlock,
  ConfirmDialog,
  IconButton,
  Page,
  Select,
  SettingRow,
  SettingSection,
  SettingsHeader,
  toast,
} from '@/ui';
import { failed, SectionError, Skeleton } from '../settings/parts';

export type Framework = Platform;

export const INSTALL_COMMAND = 'npm install @kimmi/browser';

export const FRAMEWORK_LABEL: Record<Framework, string> = PLATFORM_LABEL;

export const FRAMEWORK_OPTIONS: { value: Framework; label: string }[] = (
  ['react', 'next', 'vue', 'astro', 'svelte', 'script'] as const
).map((value) => ({ value, label: FRAMEWORK_LABEL[value] }));

/**
 * The install example for one framework: the file to edit and what to put
 * in it. `host` is where this kimmi is served, so the dashboard's own origin.
 */
export function installSnippet(framework: Framework, key: string, host = window.location.origin) {
  const init = `kimmi.init({\n  key: '${key}',\n  host: '${host}',\n});`;
  const sdk = `import kimmi from '@kimmi/browser';`;

  switch (framework) {
    case 'script':
      return {
        file: 'index.html',
        code: `<head>
  <meta charset="utf-8" />
  <script src="${host}/kimmi.js" data-key="${key}" defer></script>
</head>`,
      };
    case 'next':
      return {
        file: 'app/kimmi.tsx',
        code: `'use client';

${sdk}
import { useEffect } from 'react';

// Render <Kimmi /> once in app/layout.tsx.
export function Kimmi() {
  useEffect(() => {
    ${init.replace(/\n/g, '\n    ')}
  }, []);
  return null;
}`,
      };
    case 'vue':
      return {
        file: 'src/main.ts',
        code: `${sdk}
import { createApp } from 'vue';
import App from './App.vue';

${init}

createApp(App).mount('#app');`,
      };
    case 'astro':
      return {
        file: 'src/layouts/Layout.astro',
        code: `<script>
  ${sdk}

  ${init.replace(/\n/g, '\n  ')}
</script>`,
      };
    case 'svelte':
      return {
        file: 'src/routes/+layout.svelte',
        code: `<script lang="ts">
  ${sdk}
  import { onMount } from 'svelte';

  let { children } = $props();

  onMount(() => {
    ${init.replace(/\n/g, '\n    ')}
  });
</script>

{@render children()}`,
      };
    default:
      return {
        file: 'src/main.tsx',
        code: `${sdk}
import { createRoot } from 'react-dom/client';
import { App } from './App';

${init}

createRoot(document.getElementById('root')!).render(<App />);`,
      };
  }
}

const IDENTIFY = `kimmi.identify(user.id, {
  email: user.email,
  name: user.name,
});`;

/** One value to paste somewhere else, in mono, with its copy button. */
function CopyLine({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-center gap-3 px-5 py-3">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-mono text-fg">
        {value}
      </code>
      <IconButton
        icon={Copy}
        label={label}
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          toast('Copied to clipboard');
        }}
      />
    </div>
  );
}

function InstallGuide({ current }: { current: Project }) {
  const rotateKey = useRotateKey(current.id);
  const [framework, setFramework] = useState<Framework>(current.platform);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const snippet = installSnippet(framework, current.publicKey);
  const last = current.stats.lastRecordingAt;

  return (
    <>
      <p className="-mt-2 mb-6 text-meta text-fg-meta">
        {last ? `Last recording received ${ago(last)}.` : 'No recordings received yet.'}
      </p>

      <SettingSection
        title="Project key"
        description="Public. It can send recordings and never read them, so it is safe to ship in the browser."
      >
        <CopyLine value={current.publicKey} label="Copy key" />
      </SettingSection>

      <SettingSection title="Install" description="Add the recorder to your app.">
        <CopyLine value={INSTALL_COMMAND} label="Copy command" />
      </SettingSection>

      <SettingSection
        title={`Example (${FRAMEWORK_LABEL[framework]})`}
        description={
          framework === 'script'
            ? 'No install needed. The key is already filled in.'
            : 'The key is already filled in.'
        }
        actions={
          <Select
            label="Framework"
            size="sm"
            className="w-36"
            value={framework}
            onChange={setFramework}
            options={FRAMEWORK_OPTIONS}
          />
        }
      >
        <div className="p-3">
          <CodeBlock label={snippet.file} code={snippet.code} />
        </div>
      </SettingSection>

      <SettingSection
        title="Identify visitors"
        description="Optional. Call this after sign in to find recordings by email. Without it visitors stay anonymous."
      >
        <div className="p-3">
          <CodeBlock label="after sign in" code={IDENTIFY} />
        </div>
      </SettingSection>

      <SettingSection title="Danger zone" destructive>
        <SettingRow
          title="Rotate key"
          description="Creates a new key. Sites still using the old key stop recording at once."
        >
          <Button
            variant="danger"
            icon={RefreshCw}
            disabled={rotateKey.isPending}
            onClick={() => setConfirmRotate(true)}
          >
            Rotate key
          </Button>
        </SettingRow>
      </SettingSection>

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title="Rotate the project key?"
        description="The current key stops working at once. Recording pauses on every site until you deploy the new key."
        confirmLabel="Rotate key"
        danger
        onConfirm={() =>
          rotateKey.mutate(undefined, { onSuccess: () => toast('Key rotated'), onError: failed })
        }
      />
    </>
  );
}

/** The install page's sections while the project loads. */
function InstallSkeleton() {
  return (
    <>
      <Skeleton className="-mt-2 mb-6 h-4 w-56" />
      <SettingSection title="Project key">
        <div className="px-5 py-3">
          <Skeleton className="h-[30px] w-full" />
        </div>
      </SettingSection>
      <SettingSection title="Install" description="Add the recorder to your app.">
        <div className="px-5 py-3">
          <Skeleton className="h-[30px] w-full" />
        </div>
      </SettingSection>
      <SettingSection title="Example">
        <div className="p-3">
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      </SettingSection>
    </>
  );
}

export function Install() {
  const { projectId = '' } = useParams();
  const project = useProject(projectId);

  return (
    <Page>
      <SettingsHeader
        title="Install"
        description="Add kimmi to your site. Recording starts with the next page view."
      />
      {project.data ? (
        <InstallGuide key={project.data.id} current={project.data} />
      ) : project.isError ? (
        <SectionError
          title="Project key"
          error={project.error}
          onRetry={() => void project.refetch()}
        />
      ) : (
        <InstallSkeleton />
      )}
    </Page>
  );
}
