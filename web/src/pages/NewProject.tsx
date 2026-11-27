import { useState } from 'react';
import { useCreateProject, useProjectUntilRecorded } from '@/api/app';
import type { Platform } from '@/api/types';
import { PLATFORM_LABEL } from '@/lib/format';
import { FormError, formErrors } from '@/shell/states';
import {
  Button,
  CodeBlock,
  Input,
  LinkButton,
  Page,
  Select,
  SettingRow,
  SettingSection,
  SettingsHeader,
  toast,
} from '@/ui';

const INSTALL_COMMAND = 'npm install @kimmi/browser';

const PLATFORM_OPTIONS = (Object.keys(PLATFORM_LABEL) as Platform[]).map((value) => ({
  value,
  label: PLATFORM_LABEL[value],
}));

const SNIPPET_FILE: Record<Platform, string> = {
  react: 'src/main.tsx',
  next: 'app/kimmi.tsx',
  vue: 'src/main.ts',
  astro: 'src/layouts/Layout.astro',
  svelte: 'src/routes/+layout.svelte',
  script: 'index.html',
};

/** The few lines that start recording on a site, with this project's key filled in. */
function snippet(platform: Platform, key: string, host: string) {
  if (platform === 'script') {
    return `<script src="${host}/kimmi.js" data-key="${key}" defer></script>`;
  }
  const init = `kimmi.init({\n  key: '${key}',\n  host: '${host}',\n});`;
  const indent = (code: string, by: string) => code.replace(/\n/g, `\n${by}`);
  switch (platform) {
    case 'next':
      return `'use client';\n\nimport { kimmi } from '@kimmi/browser';\nimport { useEffect } from 'react';\n\n// Render <Kimmi /> once in app/layout.tsx.\nexport function Kimmi() {\n  useEffect(() => {\n    ${indent(init, '    ')}\n  }, []);\n  return null;\n}`;
    case 'astro':
    case 'svelte':
      return `<script>\n  import { kimmi } from '@kimmi/browser';\n\n  ${indent(init, '  ')}\n</script>`;
    default:
      return `import { kimmi } from '@kimmi/browser';\n\n${init}`;
  }
}

function siteOrigin(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.hostname.includes('.') || url.hostname === 'localhost' ? url.origin : null;
  } catch {
    return null;
  }
}

/** A field's server-side error, under its input. */
function FieldMessage({ children }: { children: string | undefined }) {
  return children ? <p className="mt-1.5 text-hint text-danger-fg">{children}</p> : null;
}

export function NewProject() {
  const [name, setName] = useState('');
  const [site, setSite] = useState('');
  const [framework, setFramework] = useState<Platform>('next');
  const create = useCreateProject();
  const created = create.data;
  const project = useProjectUntilRecorded(created?.id).data ?? created;
  const received = (project?.stats.recordings ?? 0) > 0;
  const { fields, message } = formErrors(create.error);

  const origin = siteOrigin(site);
  const ready = name.trim().length > 0 && origin !== null;
  const host = (project?.origin ?? origin)?.replace(/^https?:\/\//, '') ?? 'your site';
  const code = project ? snippet(framework, project.publicKey, window.location.origin) : '';

  return (
    <Page>
      <SettingsHeader
        title="New project"
        description="One project per site or app. Each has its own key, privacy rules and retention."
      />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || !origin || created || create.isPending) return;
          create.mutate(
            { name: name.trim(), origin, platform: framework },
            { onSuccess: () => toast('Project created') },
          );
        }}
      >
        <SettingSection title="Project details" description="You can change all of this later.">
          <SettingRow
            title="Name"
            description="Shown in the sidebar and the project list."
            htmlFor="new-project-name"
          >
            <Input
              id="new-project-name"
              autoFocus
              placeholder="Storefront"
              disabled={Boolean(created)}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <FieldMessage>{fields.name}</FieldMessage>
          </SettingRow>
          <SettingRow
            title="Site URL"
            description={
              site.trim() && !origin
                ? 'Enter a full address, for example https://shop.example.com.'
                : 'Only this site may send recordings. Add more in the project settings.'
            }
            htmlFor="new-project-site"
          >
            <Input
              id="new-project-site"
              mono
              placeholder="https://shop.example.com"
              disabled={Boolean(created)}
              value={site}
              onChange={(event) => setSite(event.target.value)}
            />
            <FieldMessage>{fields.origin}</FieldMessage>
          </SettingRow>
          <SettingRow
            title="Framework"
            description="Picks the install example. The recorder is the same for all of them."
          >
            <Select
              block
              label="Framework"
              value={framework}
              onChange={setFramework}
              options={PLATFORM_OPTIONS}
            />
            <FieldMessage>{fields.platform}</FieldMessage>
          </SettingRow>
        </SettingSection>

        {created ? null : (
          <div className="mt-5 flex items-center justify-end gap-2">
            <FormError message={message} />
            <LinkButton to="/projects" variant="ghost">
              Cancel
            </LinkButton>
            <Button type="submit" variant="primary" disabled={!ready || create.isPending}>
              Create project
            </Button>
          </div>
        )}
      </form>

      {project ? (
        <>
          <SettingSection
            title="Install"
            description={`Add kimmi to ${project.name} (${PLATFORM_LABEL[framework]}). The key is already filled in.`}
          >
            <div className="flex flex-col gap-3 p-3">
              {framework === 'script' ? null : <CodeBlock label="terminal" code={INSTALL_COMMAND} />}
              <CodeBlock label={SNIPPET_FILE[framework]} code={code} />
            </div>
          </SettingSection>

          <SettingSection title="First recording" description="This page updates by itself.">
            <SettingRow
              title={received ? 'Recording' : 'Waiting for a visit'}
              description={
                received
                  ? `${project.name} is recording. The first session has arrived.`
                  : `Deploy the snippet, then open ${host} and click around.`
              }
            >
              <div role="status" className="flex flex-col items-start gap-3">
                {received ? (
                  <>
                    <p className="text-control text-fg">First recording received</p>
                    <LinkButton to={`/projects/${project.id}/recordings`} variant="primary">
                      Open recordings
                    </LinkButton>
                  </>
                ) : (
                  <p className="flex items-center gap-2 text-control text-fg-meta">
                    <span className="size-1.5 animate-pulse-dot rounded-full bg-brand" />
                    Waiting…
                  </p>
                )}
              </div>
            </SettingRow>
          </SettingSection>
        </>
      ) : null}
    </Page>
  );
}
